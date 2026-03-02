import { spawn, type ChildProcess } from "node:child_process";
import { RelayClient } from "./client.js";

// ---------------------------------------------------------------------------
// Arg parsing (no deps)
// ---------------------------------------------------------------------------

function getArg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  const env = process.env[`VOICECI_${name.toUpperCase().replace(/-/g, "_")}`];
  if (env) return env;
  if (fallback !== undefined) return fallback;
  console.error(`Missing required argument: --${name}`);
  process.exit(1);
}

const runId = getArg("run-id");
const token = getArg("token");
const apiUrl = getArg("api-url");
const startCommand = process.argv.includes("--start-command")
  ? getArg("start-command")
  : undefined;
const agentPort = parseInt(getArg("agent-port", "3001"), 10);
const healthEndpoint = getArg("health-endpoint", "/health");

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function waitForHealth(port: number, path: string, timeoutMs = 60_000): Promise<void> {
  const url = `http://localhost:${port}${path}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  throw new Error(`Agent health check timed out after ${timeoutMs / 1000}s at ${url}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let agentProcess: ChildProcess | null = null;

async function main() {
  // 1. Connect relay first — receives env vars (API keys) from VoiceCI server
  const client = new RelayClient({
    apiUrl,
    runId,
    relayToken: token,
    agentPort,
    healthEndpoint,
  });

  console.error("[relay] Connecting to relay server...");
  await client.connect();
  console.error("[relay] Connected to relay server");

  const envKeys = Object.keys(client.agentEnv);
  if (envKeys.length > 0) {
    console.error(`[relay] Received env vars from VoiceCI: ${envKeys.join(", ")}`);
  }

  // 2. Start agent if --start-command provided, with VoiceCI env vars injected
  if (startCommand) {
    console.error(`[relay] Starting agent: ${startCommand}`);
    agentProcess = spawn(startCommand, {
      shell: true,
      stdio: "pipe",
      env: { ...process.env, ...client.agentEnv, PORT: String(agentPort) },
    });

    agentProcess.stdout?.on("data", (data: Buffer) => {
      process.stderr.write(`[agent] ${data}`);
    });
    agentProcess.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[agent] ${data}`);
    });

    agentProcess.on("exit", (code, signal) => {
      console.error(`[relay] Agent process exited (code=${code}, signal=${signal})`);
    });

    // 3. Wait for health
    console.error(`[relay] Waiting for agent health at localhost:${agentPort}${healthEndpoint}...`);
    await waitForHealth(agentPort, healthEndpoint);
    console.error("[relay] Agent is healthy");
  }

  // 4. Activate the run (queue the test job)
  console.error("[relay] Activating run...");
  await client.activate();
  console.error("[relay] Run activated — tests will start shortly");

  // 5. Listen for events
  client.on("run_complete", () => {
    console.error("[relay] Tests complete");
  });

  client.on("disconnected", () => {
    console.error("[relay] Disconnected from relay server");
  });

  client.on("error", (err: unknown) => {
    console.error("[relay] Error:", err instanceof Error ? err.message : err);
  });

  // 6. Handle shutdown
  const shutdown = () => {
    console.error("[relay] Shutting down...");
    client.disconnect();
    if (agentProcess) {
      agentProcess.kill("SIGTERM");
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[relay] Fatal error:", err.message);
  if (agentProcess) agentProcess.kill("SIGTERM");
  process.exit(1);
});
