import { execSync, spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env["LIGHTMCP_API_KEY"] ?? process.env["VOICECI_API_KEY"];
if (!API_KEY) {
  process.stderr.write(
    "Error: LIGHTMCP_API_KEY environment variable is required.\n" +
      "Get your key at https://lightmcp.com\n",
  );
  process.exit(1);
}

const REMOTE_URL =
  process.env["LIGHTMCP_URL"] ?? process.env["VOICECI_URL"] ?? "https://voiceci-api.fly.dev/mcp";
const REQUEST_TIMEOUT = 600_000; // 10 minutes — test runs can be long

const log = (msg: string) => process.stderr.write(`[lightmcp] ${msg}\n`);

// ---------------------------------------------------------------------------
// Relay session types & state
// ---------------------------------------------------------------------------

interface RelayConfig {
  run_id: string;
  relay_token: string;
  api_url: string;
  agent_port: number;
  start_command: string | null;
  health_endpoint: string;
}

interface RelaySession {
  runId: string;
  controlWs: WebSocket | null;
  dataConnections: Map<string, { relay: WebSocket; local: WebSocket }>;
  agentProcess: ChildProcess | null;
  closed: boolean;
}

const relaySessions = new Map<string, RelaySession>();

// ---------------------------------------------------------------------------
// Relay: port cleanup
// ---------------------------------------------------------------------------

async function killPort(port: number): Promise<void> {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (pids) {
      for (const pid of pids.split("\n")) {
        try {
          process.kill(parseInt(pid, 10), "SIGKILL");
        } catch { /* already gone */ }
      }
      log(`Killed existing process(es) on port ${port}`);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const check = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim();
          if (!check) break;
        } catch { break; }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  } catch { /* lsof not available — fine */ }
}

// ---------------------------------------------------------------------------
// Relay: health check
// ---------------------------------------------------------------------------

async function waitForHealth(port: number, path: string, timeoutMs = 60_000): Promise<void> {
  const url = `http://localhost:${port}${path}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  throw new Error(`Agent health check timed out after ${timeoutMs / 1000}s at ${url}`);
}

// ---------------------------------------------------------------------------
// Relay: open a WebSocket with promise
// ---------------------------------------------------------------------------

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.on("open", () => resolve(ws));
    ws.on("error", (err) => reject(err));
  });
}

// ---------------------------------------------------------------------------
// Relay: handle new data connection (bidirectional bridge)
// ---------------------------------------------------------------------------

async function handleNewConnection(session: RelaySession, config: RelayConfig, connId: string): Promise<void> {
  const agentUrl = `ws://localhost:${config.agent_port}`;
  const wsBase = config.api_url.replace(/^http/, "ws");
  const dataUrl = `${wsBase}/relay/data?run_id=${config.run_id}&conn_id=${connId}&token=${config.relay_token}`;

  try {
    const [localWs, relayWs] = await Promise.all([
      openWs(agentUrl),
      openWs(dataUrl),
    ]);

    // Bidirectional forwarding
    localWs.on("message", (data) => {
      if (relayWs.readyState === WebSocket.OPEN) relayWs.send(data);
    });
    relayWs.on("message", (data) => {
      if (localWs.readyState === WebSocket.OPEN) localWs.send(data);
    });

    const cleanup = () => {
      if (localWs.readyState !== WebSocket.CLOSED) localWs.close();
      if (relayWs.readyState !== WebSocket.CLOSED) relayWs.close();
      session.dataConnections.delete(connId);
    };

    localWs.on("close", cleanup);
    relayWs.on("close", cleanup);
    localWs.on("error", cleanup);
    relayWs.on("error", cleanup);

    session.dataConnections.set(connId, { relay: relayWs, local: localWs });
  } catch (err) {
    log(`Failed to establish data connection ${connId}: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Relay: cleanup session
// ---------------------------------------------------------------------------

function cleanupRelay(runId: string): void {
  const session = relaySessions.get(runId);
  if (!session) return;

  session.closed = true;

  for (const [, conn] of session.dataConnections) {
    conn.relay.close();
    conn.local.close();
  }
  session.dataConnections.clear();

  if (session.controlWs) {
    session.controlWs.close();
    session.controlWs = null;
  }

  if (session.agentProcess) {
    session.agentProcess.kill("SIGTERM");
    session.agentProcess = null;
  }

  relaySessions.delete(runId);
  log(`Cleaned up relay session for run ${runId}`);
}

// ---------------------------------------------------------------------------
// Relay: start relay (fire-and-forget)
// ---------------------------------------------------------------------------

async function startRelay(config: RelayConfig): Promise<void> {
  const session: RelaySession = {
    runId: config.run_id,
    controlWs: null,
    dataConnections: new Map(),
    agentProcess: null,
    closed: false,
  };
  relaySessions.set(config.run_id, session);

  try {
    // 1. Connect control WebSocket
    const wsBase = config.api_url.replace(/^http/, "ws");
    const controlUrl = `${wsBase}/relay/control?run_id=${config.run_id}&token=${config.relay_token}`;

    log("Connecting to relay server...");
    const controlWs = await openWs(controlUrl);
    session.controlWs = controlWs;
    log("Connected to relay server");

    // Wait for config message (env vars) with 3s timeout
    const agentEnv = await new Promise<Record<string, string>>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve({}); }
      }, 3_000);

      controlWs.on("message", function onMsg(raw) {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer)) as {
            type: string;
            env?: Record<string, string>;
          };
          if (msg.type === "config" && msg.env) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve(msg.env);
            }
          }
        } catch { /* ignore */ }
      });
    });

    const envKeys = Object.keys(agentEnv);
    if (envKeys.length > 0) {
      log(`Received env vars: ${envKeys.join(", ")}`);
    }

    // Set up control message handler for new_connection and run_complete
    controlWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer)) as {
          type: string;
          conn_id?: string;
        };
        if (msg.type === "new_connection" && msg.conn_id) {
          handleNewConnection(session, config, msg.conn_id).catch((err) => {
            log(`Connection handler error: ${err instanceof Error ? err.message : err}`);
          });
        } else if (msg.type === "run_complete") {
          log("Tests complete — cleaning up relay");
          cleanupRelay(config.run_id);
        }
      } catch { /* ignore */ }
    });

    controlWs.on("close", () => {
      session.controlWs = null;
      if (!session.closed) {
        log("Control connection closed unexpectedly");
        cleanupRelay(config.run_id);
      }
    });

    controlWs.on("error", (err) => {
      log(`Control WebSocket error: ${err.message}`);
    });

    // 2. Start agent if start_command provided
    if (config.start_command) {
      await killPort(config.agent_port);
      log(`Starting agent: ${config.start_command}`);
      const agentProcess = spawn(config.start_command, {
        shell: true,
        stdio: "pipe",
        env: { ...process.env, ...agentEnv, PORT: String(config.agent_port) },
      });

      session.agentProcess = agentProcess;

      agentProcess.stdout?.on("data", (data: Buffer) => {
        process.stderr.write(`[lightmcp-agent] ${data}`);
      });
      agentProcess.stderr?.on("data", (data: Buffer) => {
        process.stderr.write(`[lightmcp-agent] ${data}`);
      });
      agentProcess.on("exit", (code, signal) => {
        log(`Agent process exited (code=${code}, signal=${signal})`);
      });

      // 3. Wait for health
      log(`Waiting for agent health at localhost:${config.agent_port}${config.health_endpoint}...`);
      await waitForHealth(config.agent_port, config.health_endpoint);
      log("Agent is healthy");
    }

    // 4. Activate the run
    log("Activating run...");
    const activateUrl = `${config.api_url}/internal/runs/${config.run_id}/activate`;
    const res = await fetch(activateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relay_token: config.relay_token }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Activation failed (${res.status}): ${text}`);
    }
    log("Run activated — tests will start shortly");
  } catch (err) {
    log(`Relay error: ${err instanceof Error ? err.message : err}`);
    cleanupRelay(config.run_id);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Connect to the remote VoiceCI MCP server over HTTP
  const upstream = new Client(
    { name: "lightmcp-proxy", version: "0.5.0" },
    { capabilities: {} },
  );

  const httpTransport = new StreamableHTTPClientTransport(
    new URL(REMOTE_URL),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
    },
  );

  await upstream.connect(httpTransport);

  // Create the local stdio server that MCP clients (Claude Code, Cursor) talk to
  const server = new Server(
    { name: "lightmcp", version: "0.5.0" },
    { capabilities: { tools: {} } },
  );

  // Forward tools/list → upstream
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return await upstream.listTools();
  });

  // Forward tools/call → upstream, intercept relay_config in response
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await upstream.callTool(request.params, undefined, {
      timeout: REQUEST_TIMEOUT,
      resetTimeoutOnProgress: true,
    });

    // Check if the response contains relay_config — if so, start relay in background
    // and return a sanitized response (identical to the remote agent path)
    if (result.content && Array.isArray(result.content) && result.content.length > 0) {
      const first = result.content[0];
      if (first && typeof first === "object" && "text" in first && typeof first.text === "string") {
        try {
          const parsed = JSON.parse(first.text) as Record<string, unknown>;
          if (parsed.relay_config && typeof parsed.relay_config === "object") {
            const relayConfig = parsed.relay_config as RelayConfig;

            // Start relay in background (fire-and-forget)
            startRelay(relayConfig).catch((err) => {
              log(`Failed to start relay: ${err instanceof Error ? err.message : err}`);
            });

            // Return sanitized response — no relay_command, no relay_config
            const sanitized = {
              run_id: parsed.run_id,
              status: parsed.status,
              message: parsed.message,
            };
            return {
              ...result,
              content: [{
                type: "text" as const,
                text: JSON.stringify(sanitized, null, 2),
              }],
            };
          }
        } catch {
          // Not JSON or no relay_config — pass through
        }
      }
    }

    return result;
  });

  // Start listening on stdio
  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  // Graceful shutdown
  const shutdown = async () => {
    // Clean up all relay sessions
    for (const runId of relaySessions.keys()) {
      cleanupRelay(runId);
    }
    await server.close();
    await upstream.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
