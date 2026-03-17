import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import { schema } from "@vent/db";
import { RUNNER_CALLBACK_HEADER } from "@vent/shared";
import { broadcast } from "../lib/run-subscribers.js";
import type WebSocket from "ws";

// ---------------------------------------------------------------------------
// Load bundled relay client at startup (served at GET /relay/client.mjs)
// ---------------------------------------------------------------------------

let relayClientBundle: string;
try {
  relayClientBundle = readFileSync(join(__dirname, "..", "relay-client.mjs"), "utf-8");
} catch {
  relayClientBundle = "// relay-client bundle not found — build packages/relay-client first";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunnerConnection {
  runner: WebSocket;
  connId: string;
  buffered: Buffer[];
  ready: boolean;
}

interface RelaySession {
  runId: string;
  userId: string;
  controlWs: WebSocket;
  connections: Map<string, RunnerConnection>;
  createdAt: number;
  pingInterval: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const relaySessions = new Map<string, RelaySession>();

const PING_INTERVAL_MS = 30_000;
const MAX_BUFFER_BYTES = 1_048_576; // 1 MB safety limit per connection

// Redis — pub/sub for instant notification + key for cross-instance relay-ready checks
const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const redisPub = new IORedis(redisUrl, { maxRetriesPerRequest: null });

// ---------------------------------------------------------------------------
// Binary framing helpers
// ---------------------------------------------------------------------------

function sendDataFrame(session: RelaySession, connId: string, payload: Buffer): void {
  if (session.controlWs.readyState !== session.controlWs.OPEN) return;
  const header = Buffer.alloc(37);
  header[0] = 0x01;
  header.write(connId, 1, 36, "ascii");
  const frame = Buffer.concat([header, payload]);
  session.controlWs.send(frame, { binary: true });
}

function parseDataFrame(data: Buffer): { connId: string; payload: Buffer } | null {
  if (data.length < 37 || data[0] !== 0x01) return null;
  const connId = data.toString("ascii", 1, 37);
  const payload = data.subarray(37);
  return { connId, payload };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRelaySession(runId: string): RelaySession | null {
  return relaySessions.get(runId) ?? null;
}

function sendControl(session: RelaySession, payload: Record<string, unknown>): void {
  try {
    if (session.controlWs.readyState === session.controlWs.OPEN) {
      session.controlWs.send(JSON.stringify(payload));
    }
  } catch {
    // Best-effort delivery
  }
}

function cleanupSession(runId: string): void {
  const session = relaySessions.get(runId);
  if (!session) return;

  clearInterval(session.pingInterval);

  for (const [, conn] of session.connections) {
    if (conn.runner.readyState === conn.runner.OPEN) conn.runner.close();
  }

  session.connections.clear();
  relaySessions.delete(runId);

  // Clean up Redis key
  void redisPub.del(`vent:relay-session:${runId}`);
}

function notifyRunComplete(runId: string): void {
  const session = relaySessions.get(runId);
  if (!session) return;

  sendControl(session, { type: "run_complete" });

  setTimeout(() => {
    if (session.controlWs.readyState === session.controlWs.OPEN) {
      session.controlWs.close(1000, "run_complete");
    }
    cleanupSession(runId);
  }, 500);
}

function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

async function relayRoutes(app: FastifyInstance) {
  // GET /relay/control — Control + data channel from the relay client (multiplexed)
  app.get("/relay/control", { websocket: true }, async (socket, req) => {
    const query = req.query as { run_id?: string; token?: string };
    const runId = query.run_id;
    const token = query.token;

    if (!runId || !token || !isValidUUID(runId)) {
      socket.close(4400, "Missing or invalid run_id/token");
      return;
    }

    if (relaySessions.has(runId)) {
      socket.close(4409, "Relay already connected for this run");
      return;
    }

    let run: { id: string; user_id: string; relay_token: string | null } | undefined;
    try {
      const [row] = await app.db
        .select({
          id: schema.runs.id,
          user_id: schema.runs.user_id,
          relay_token: schema.runs.relay_token,
        })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .limit(1);
      run = row;
    } catch (err) {
      app.log.error({ runId, err }, "relay/control: DB lookup failed");
      socket.close(4500, "Internal error");
      return;
    }

    if (!run) {
      socket.close(4404, "Run not found");
      return;
    }

    if (!run.relay_token || run.relay_token !== token) {
      socket.close(4401, "Invalid relay token");
      return;
    }

    const pingInterval = setInterval(() => {
      try {
        if (socket.readyState === socket.OPEN) {
          socket.ping();
        }
      } catch {
        // Socket went away
      }
    }, PING_INTERVAL_MS);

    const session: RelaySession = {
      runId,
      userId: run.user_id,
      controlWs: socket,
      connections: new Map(),
      createdAt: Date.now(),
      pingInterval,
    };

    relaySessions.set(runId, session);
    app.log.info({ runId }, "relay/control: connected");

    // Set a persistent Redis key so the worker can confirm relay is ready.
    try {
      const machineId = process.env["FLY_MACHINE_ID"] ?? "local";
      await redisPub.set(`vent:relay-session:${runId}`, machineId, "EX", 600);
      app.log.info({ runId }, "relay/control: Redis key SET confirmed");
    } catch (err) {
      app.log.error({ runId, err }, "relay/control: FAILED to set Redis key");
    }

    // Notify worker via Redis pub/sub — instant notification
    try {
      await redisPub.publish(`vent:relay-ready:${runId}`, "1");
      app.log.info({ runId }, "relay/control: Redis PUBLISH confirmed");
    } catch (err) {
      app.log.error({ runId, err }, "relay/control: FAILED to publish relay-ready");
    }

    // Send agent env vars so relay-client can inject them into the agent process.
    const agentEnv: Record<string, string> = {};
    const FORWARDED_KEYS = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"];
    for (const key of FORWARDED_KEYS) {
      const val = process.env[key];
      if (val) agentEnv[key] = val;
    }
    sendControl(session, { type: "config", env: agentEnv });

    broadcast(runId, {
      run_id: runId,
      event_type: "relay_connected",
      message: "Local dev tunnel connected",
      created_at: new Date().toISOString(),
    });

    // Handle multiplexed data + control messages from CLI
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Binary frame: data from local agent → forward to runner
        const frame = parseDataFrame(data);
        if (!frame) return;
        const conn = session.connections.get(frame.connId);
        if (conn && conn.runner.readyState === conn.runner.OPEN) {
          conn.runner.send(frame.payload, { binary: true });
        }
      } else {
        // Text frame: control message from CLI
        try {
          const msg = JSON.parse(data.toString()) as { type: string; conn_id?: string };
          if (msg.type === "open_ack" && msg.conn_id) {
            const conn = session.connections.get(msg.conn_id);
            if (conn) {
              conn.ready = true;
              // Flush buffered runner data
              for (const buf of conn.buffered) {
                sendDataFrame(session, msg.conn_id, buf);
              }
              conn.buffered = [];
              app.log.info({ runId, connId: msg.conn_id }, "relay/control: open_ack received, flushed buffer");
            }
          } else if (msg.type === "close" && msg.conn_id) {
            const conn = session.connections.get(msg.conn_id);
            if (conn && conn.runner.readyState === conn.runner.OPEN) {
              conn.runner.close();
            }
            session.connections.delete(msg.conn_id);
          }
        } catch {
          // Ignore malformed
        }
      }
    });

    socket.on("close", () => {
      app.log.info({ runId }, "relay/control: disconnected");
      cleanupSession(runId);
    });

    socket.on("error", (err) => {
      app.log.error({ runId, err: err.message }, "relay/control: socket error");
      cleanupSession(runId);
    });
  });

  // GET /relay/connect — Runner (worker) data channel, one per test
  app.get("/relay/connect", { websocket: true }, async (socket, req) => {
    const query = req.query as { run_id?: string; conn_id?: string };
    const runId = query.run_id;
    const connId = query.conn_id;

    const secret = (req.headers as Record<string, string>)[RUNNER_CALLBACK_HEADER];
    const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];

    if (!expectedSecret || secret !== expectedSecret) {
      socket.close(4401, "Unauthorized");
      return;
    }

    if (!runId || !connId || !isValidUUID(runId) || !isValidUUID(connId)) {
      socket.close(4400, "Missing or invalid run_id/conn_id");
      return;
    }

    const session = relaySessions.get(runId);
    if (!session) {
      socket.close(4404, "No relay session for this run");
      return;
    }

    if (session.connections.has(connId)) {
      socket.close(4409, "Connection already exists for this conn_id");
      return;
    }

    const conn: RunnerConnection = {
      runner: socket,
      connId,
      buffered: [],
      ready: false,
    };
    session.connections.set(connId, conn);
    app.log.info({ runId, connId }, "relay/connect: runner connected");

    // Notify CLI of new connection
    sendControl(session, { type: "new_connection", conn_id: connId });

    // Forward runner data to CLI over control WS (multiplexed)
    let bufferedBytes = 0;
    socket.on("message", (data: Buffer) => {
      const payload = Buffer.from(data);
      if (conn.ready) {
        sendDataFrame(session, connId, payload);
      } else {
        bufferedBytes += payload.length;
        if (bufferedBytes > MAX_BUFFER_BYTES) {
          app.log.warn({ runId, connId, bufferedBytes }, "relay/connect: buffer limit exceeded, closing");
          socket.close(4413, "Buffer limit exceeded");
          return;
        }
        conn.buffered.push(payload);
      }
    });

    socket.on("close", () => {
      // Notify CLI that this connection closed
      sendControl(session, { type: "close", conn_id: connId });
      session.connections.delete(connId);
    });

    socket.on("error", (err) => {
      app.log.error({ runId, connId, err: err.message }, "relay/connect: socket error");
    });
  });

  // GET /internal/relay-ready/:id — Worker polls this to know when relay tunnel is connected
  app.get<{ Params: { id: string } }>("/internal/relay-ready/:id", async (request, reply) => {
    const secret = (request.headers as Record<string, string>)[RUNNER_CALLBACK_HEADER];
    const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];
    if (!expectedSecret || secret !== expectedSecret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    // Check local in-memory first (fast path), then Redis (cross-instance)
    if (relaySessions.has(request.params.id)) {
      return reply.send({ ready: true });
    }

    const redisReady = await redisPub.get(`vent:relay-session:${request.params.id}`);
    if (redisReady) {
      return reply.send({ ready: true });
    }

    return reply.status(404).send({ ready: false });
  });

  // GET /relay/client.mjs — Serve the bundled relay client script
  app.get("/relay/client.mjs", async (_request, reply) => {
    return reply
      .header("Content-Type", "application/javascript; charset=utf-8")
      .header("Cache-Control", "no-cache")
      .send(relayClientBundle);
  });

  // Cleanup on server shutdown
  app.addHook("onClose", async () => {
    for (const [runId] of relaySessions) {
      cleanupSession(runId);
    }
    redisPub.disconnect();
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  relayRoutes,
  relaySessions,
  getRelaySession,
  notifyRunComplete,
};
export type { RelaySession, RunnerConnection };
