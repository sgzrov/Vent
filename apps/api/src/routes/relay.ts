import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@voiceci/db";
import { RUNNER_CALLBACK_HEADER } from "@voiceci/shared";
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

interface RelayConnection {
  runner: WebSocket | null;
  agent: WebSocket | null;
  pairedAt: number | null;
  pairTimeout: ReturnType<typeof setTimeout> | null;
}

interface RelaySession {
  runId: string;
  userId: string;
  controlWs: WebSocket;
  connections: Map<string, RelayConnection>;
  createdAt: number;
  pingInterval: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const relaySessions = new Map<string, RelaySession>();

const PAIR_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 30_000;

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

function pairConnections(connId: string, conn: RelayConnection): void {
  if (!conn.runner || !conn.agent) return;

  if (conn.pairTimeout) {
    clearTimeout(conn.pairTimeout);
    conn.pairTimeout = null;
  }

  conn.pairedAt = Date.now();

  const runner = conn.runner;
  const agent = conn.agent;

  runner.on("message", (data: Buffer, isBinary: boolean) => {
    if (agent.readyState === agent.OPEN) {
      agent.send(data, { binary: isBinary });
    }
  });

  agent.on("message", (data: Buffer, isBinary: boolean) => {
    if (runner.readyState === runner.OPEN) {
      runner.send(data, { binary: isBinary });
    }
  });

  runner.on("close", () => {
    if (agent.readyState === agent.OPEN) agent.close();
  });
  agent.on("close", () => {
    if (runner.readyState === runner.OPEN) runner.close();
  });
}

function cleanupSession(runId: string): void {
  const session = relaySessions.get(runId);
  if (!session) return;

  clearInterval(session.pingInterval);

  for (const [, conn] of session.connections) {
    if (conn.pairTimeout) clearTimeout(conn.pairTimeout);
    if (conn.runner?.readyState === conn.runner?.OPEN) conn.runner?.close();
    if (conn.agent?.readyState === conn.agent?.OPEN) conn.agent?.close();
  }

  session.connections.clear();
  relaySessions.delete(runId);
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
  // GET /relay/control — Control channel from the relay client
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

    // Send agent env vars so relay-client can inject them into the agent process.
    // VoiceCI provides its own keys — users never need to set up their own.
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

    let conn = session.connections.get(connId);
    if (!conn) {
      conn = {
        runner: null,
        agent: null,
        pairedAt: null,
        pairTimeout: null,
      };
      session.connections.set(connId, conn);
    }

    if (conn.runner) {
      socket.close(4409, "Runner already connected for this conn_id");
      return;
    }

    conn.runner = socket;
    app.log.info({ runId, connId }, "relay/connect: runner connected");

    sendControl(session, { type: "new_connection", conn_id: connId });

    if (conn.agent) {
      pairConnections(connId, conn);
    } else {
      conn.pairTimeout = setTimeout(() => {
        app.log.warn({ runId, connId }, "relay/connect: pair timeout");
        if (socket.readyState === socket.OPEN) {
          socket.close(4408, "Pair timeout: agent did not connect");
        }
        session.connections.delete(connId);
      }, PAIR_TIMEOUT_MS);
    }

    socket.on("close", () => {
      const c = session.connections.get(connId);
      if (c) {
        if (c.pairTimeout) clearTimeout(c.pairTimeout);
        session.connections.delete(connId);
      }
    });

    socket.on("error", (err) => {
      app.log.error({ runId, connId, err: err.message }, "relay/connect: socket error");
    });
  });

  // GET /relay/data — Agent data channel from relay client, one per test
  app.get("/relay/data", { websocket: true }, async (socket, req) => {
    const query = req.query as { run_id?: string; conn_id?: string; token?: string };
    const runId = query.run_id;
    const connId = query.conn_id;
    const token = query.token;

    if (!runId || !connId || !token || !isValidUUID(runId) || !isValidUUID(connId)) {
      socket.close(4400, "Missing or invalid run_id/conn_id/token");
      return;
    }

    const session = relaySessions.get(runId);
    if (!session) {
      socket.close(4404, "No relay session for this run");
      return;
    }

    let run: { relay_token: string | null } | undefined;
    try {
      const [row] = await app.db
        .select({ relay_token: schema.runs.relay_token })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .limit(1);
      run = row;
    } catch (err) {
      app.log.error({ runId, connId, err }, "relay/data: DB lookup failed");
      socket.close(4500, "Internal error");
      return;
    }

    if (!run || !run.relay_token || run.relay_token !== token) {
      socket.close(4401, "Invalid relay token");
      return;
    }

    const conn = session.connections.get(connId);
    if (!conn) {
      socket.close(4404, "No connection slot for this conn_id");
      return;
    }

    if (conn.agent) {
      socket.close(4409, "Agent already connected for this conn_id");
      return;
    }

    conn.agent = socket;
    app.log.info({ runId, connId }, "relay/data: agent connected");

    if (conn.runner) {
      pairConnections(connId, conn);
    }

    socket.on("close", () => {
      const c = session.connections.get(connId);
      if (c) {
        if (c.pairTimeout) clearTimeout(c.pairTimeout);
        session.connections.delete(connId);
      }
    });

    socket.on("error", (err) => {
      app.log.error({ runId, connId, err: err.message }, "relay/data: socket error");
    });
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
export type { RelaySession, RelayConnection };
