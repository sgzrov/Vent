import { spawn, type ChildProcess } from "node:child_process";
import { RelayClient, type RelayClientConfig } from "@vent/relay-client";

export interface RelayHandle {
  client: RelayClient;
  agentProcess: ChildProcess | null;
  cleanup: () => Promise<void>;
}

/**
 * Start relay and optionally spawn the agent process.
 */
export async function startRelay(relayConfig: {
  run_id: string;
  relay_token: string;
  api_url: string;
  agent_port: number;
  start_command: string | null;
  health_endpoint: string;
}): Promise<RelayHandle> {
  const clientConfig: RelayClientConfig = {
    apiUrl: relayConfig.api_url,
    runId: relayConfig.run_id,
    relayToken: relayConfig.relay_token,
    agentPort: relayConfig.agent_port,
    healthEndpoint: relayConfig.health_endpoint,
  };

  const client = new RelayClient(clientConfig);
  await client.connect();

  let agentProcess: ChildProcess | null = null;

  if (relayConfig.start_command) {
    const env = { ...process.env, ...client.agentEnv, PORT: String(relayConfig.agent_port) };
    agentProcess = spawn(relayConfig.start_command, {
      shell: true,
      stdio: "pipe",
      env,
    });

    agentProcess.on("error", (err) => {
      process.stderr.write(`Agent process error: ${err.message}\n`);
    });
  }

  // Wait briefly for agent health, then activate
  if (relayConfig.start_command) {
    await waitForHealth(relayConfig.agent_port, relayConfig.health_endpoint);
  }
  await client.activate();

  const cleanup = async () => {
    if (agentProcess && !agentProcess.killed) {
      agentProcess.kill("SIGTERM");
    }
    await client.disconnect();
  };

  return { client, agentProcess, cleanup };
}

async function waitForHealth(port: number, endpoint: string, timeoutMs = 30_000): Promise<void> {
  const url = `http://localhost:${port}${endpoint}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Agent health check timed out after ${timeoutMs}ms at ${url}`);
}
