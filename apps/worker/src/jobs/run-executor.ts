import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import { createDb, schema, type Database } from "@vent/db";
import { RUNNER_CALLBACK_HEADER, formatConversationResult } from "@vent/shared";
import type {
  CallSpec,
  AdapterType,
  PlatformConfig,
} from "@vent/shared";
import type { AudioChannelConfig } from "@vent/adapters";
import {
  decryptSecrets,
  mergePlatformConfig,
  type EncryptedSecretsEnvelope,
} from "@vent/platform-connections";
import { executeCalls } from "@vent/runner/executor";

// ---------------------------------------------------------------------------
// Event emission — writes to DB and notifies API for SSE broadcast
// ---------------------------------------------------------------------------

async function emitEvent(
  _db: Database,
  runId: string,
  eventType: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    // POST to API — it handles both DB write and SSE broadcast.
    // (Don't write to DB here too, or events get duplicated.)
    const apiUrl = process.env["API_URL"] ?? "https://vent-api.fly.dev";
    const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
    await fetch(`${apiUrl}/internal/run-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RUNNER_CALLBACK_HEADER]: secret,
      },
      body: JSON.stringify({ run_id: runId, event_type: eventType, message, metadata_json: metadata }),
    });
  } catch {
    // Best-effort — don't fail the run if event emission fails
  }
}

interface RunJob {
  run_id: string;
  adapter?: string;
  call_spec?: Record<string, unknown>;
  voice_config?: Record<string, unknown>;
  start_command?: string;
  health_endpoint?: string;
  agent_url?: string;
  platform_connection_id?: string | null;
  agent_session_id?: string;
}

async function resolvePlatformConfig(
  db: Database,
  platformConnectionId?: string | null,
): Promise<PlatformConfig | undefined> {
  if (!platformConnectionId) return undefined;

  const [savedConnection] = await db
    .select({
      id: schema.platformConnections.id,
      config_json: schema.platformConnections.config_json,
      secrets_encrypted: schema.platformConnections.secrets_encrypted,
    })
    .from(schema.platformConnections)
    .where(eq(schema.platformConnections.id, platformConnectionId))
    .limit(1);

  if (!savedConnection) {
    throw new Error(`Platform connection ${platformConnectionId} not found`);
  }

  await db
    .update(schema.platformConnections)
    .set({ last_used_at: new Date() })
    .where(eq(schema.platformConnections.id, savedConnection.id));

  return mergePlatformConfig(
    savedConnection.config_json as Record<string, unknown>,
    decryptSecrets(savedConnection.secrets_encrypted as EncryptedSecretsEnvelope),
  );
}

// ---------------------------------------------------------------------------
// Direct execution for already-deployed agents (platform adapters or agent_url)
// ---------------------------------------------------------------------------

async function executeRemoteRun(db: Database, job: RunJob): Promise<void> {
  const apiUrl = process.env["API_URL"] ?? "https://vent-api.fly.dev";
  const callbackSecret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  const callbackUrl = `${apiUrl}/internal/runner-callback`;

  const adapterType = (job.adapter ?? "websocket") as AdapterType;
  const agentUrl = job.agent_url ?? "http://localhost:3001";
  const platform = await resolvePlatformConfig(db, job.platform_connection_id);
  const callSpec = job.call_spec as CallSpec;

  const channelConfig: AudioChannelConfig = {
    adapter: adapterType,
    agentUrl,
    platform,
  };

  const allSpecs = callSpec.conversation_calls ?? [];
  const totalCalls = allSpecs.reduce(
    (sum, t) => sum + ((t as { repeat?: number }).repeat ?? 1), 0
  );
  let completedCalls = 0;

  try {
    const platformConcurrency = platform?.max_concurrency as number | undefined;
    const { status, conversationResults, aggregate } = await executeCalls({
      runId: job.run_id,
      callSpec,
      channelConfig,
      concurrencyLimit: platformConcurrency,
      onCallComplete: async (result) => {
        completedCalls++;
        const callName = result.name ?? "conversation";

        try {
          const res = await fetch(`${apiUrl}/internal/call-progress`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [RUNNER_CALLBACK_HEADER]: callbackSecret,
            },
            body: JSON.stringify({
              run_id: job.run_id,
              completed: completedCalls,
              total: totalCalls,
              call_type: "conversation",
              call_name: callName,
              status: result.status,
              duration_ms: result.duration_ms,
              result: formatConversationResult(result),
            }),
          });
          if (!res.ok) console.warn(`call-progress POST failed (${res.status}) for ${callName}`);
        } catch (err) {
          console.warn(`call-progress POST error for ${callName}:`, (err as Error).message);
        }
      },
    });

    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RUNNER_CALLBACK_HEADER]: callbackSecret,
      },
      body: JSON.stringify({
        run_id: job.run_id,
        status,
        conversation_results: conversationResults,
        aggregate,
      }),
    });

    if (!response.ok) {
      throw new Error(`Callback failed: ${response.status} ${await response.text()}`);
    }

    console.log(`Remote run ${job.run_id} completed: ${status}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`Remote run ${job.run_id} failed:`, errorMessage);

    await db
      .update(schema.runs)
      .set({
        status: "fail",
        finished_at: new Date(),
        error_text: errorMessage,
      })
      .where(eq(schema.runs.id, job.run_id));
  }
}

// ---------------------------------------------------------------------------
// Relay execution — calls run in worker, audio flows through relay to local agent
// ---------------------------------------------------------------------------

async function executeSessionRun(db: Database, job: RunJob, relayMachineId: string): Promise<void> {
  const apiUrl = process.env["API_URL"] ?? "https://vent-api.fly.dev";
  const callbackSecret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  const callbackUrl = `${apiUrl}/internal/runner-callback`;

  // Build relay connect URL using session_id — the WsAudioChannel will append conn_id automatically
  const relayWsUrl = apiUrl.replace(/^http/, "ws") + `/relay/connect?session_id=${job.agent_session_id}`;

  // Pin all relay connections to the API machine that holds the relay session.
  // Without this, Fly.io load-balances across machines and connections hit
  // instances that have no in-memory session → 4404 → "WebSocket not connected".
  const relayHeaders: Record<string, string> = {};
  if (relayMachineId && relayMachineId !== "local") {
    relayHeaders["fly-force-instance-id"] = relayMachineId;
    console.log(`[relay] Pinning connections to Fly machine ${relayMachineId}`);
  }

  const channelConfig: AudioChannelConfig = {
    adapter: "websocket",
    agentUrl: relayWsUrl,
    relayHeaders,
  };

  const callSpec = job.call_spec as CallSpec;
  const allSpecs = callSpec.conversation_calls ?? [];
  const totalCalls = allSpecs.reduce(
    (sum, t) => sum + ((t as { repeat?: number }).repeat ?? 1), 0
  );
  let completedCalls = 0;

  try {
    const { status, conversationResults, aggregate } = await executeCalls({
      runId: job.run_id,
      callSpec,
      channelConfig,
      concurrencyLimit: undefined,
      onCallComplete: async (result) => {
        completedCalls++;
        const callName = result.name ?? "conversation";

        try {
          const res = await fetch(`${apiUrl}/internal/call-progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json", [RUNNER_CALLBACK_HEADER]: callbackSecret },
            body: JSON.stringify({
              run_id: job.run_id,
              completed: completedCalls,
              total: totalCalls,
              call_type: "conversation",
              call_name: callName,
              status: result.status,
              duration_ms: result.duration_ms,
              result: formatConversationResult(result),
            }),
          });
          if (!res.ok) console.warn(`call-progress POST failed (${res.status}) for ${callName}`);
        } catch (err) {
          console.warn(`call-progress POST error for ${callName}:`, (err as Error).message);
        }
      },
    });

    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", [RUNNER_CALLBACK_HEADER]: callbackSecret },
      body: JSON.stringify({
        run_id: job.run_id,
        status,
        conversation_results: conversationResults,
        aggregate,
      }),
    });

    if (!response.ok) {
      throw new Error(`Callback failed: ${response.status} ${await response.text()}`);
    }

    console.log(`Session run ${job.run_id} completed: ${status}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`Session run ${job.run_id} failed:`, errorMessage);

    await db
      .update(schema.runs)
      .set({
        status: "fail",
        finished_at: new Date(),
        error_text: errorMessage,
      })
      .where(eq(schema.runs.id, job.run_id));
  }
}

// ---------------------------------------------------------------------------
// Module-level DB — single connection pool shared across all jobs
// ---------------------------------------------------------------------------

const db = createDb(process.env["DATABASE_URL"]!);

// ---------------------------------------------------------------------------
// Look up relay session machine from Redis (session is already connected)
// ---------------------------------------------------------------------------

async function getSessionMachineId(sessionId: string): Promise<string> {
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const key = `vent:relay-session:${sessionId}`;

  try {
    const machineId = await redis.get(key);
    if (!machineId) {
      throw new Error(`Agent session ${sessionId} relay not found in Redis — is the tunnel still connected?`);
    }
    return machineId;
  } finally {
    redis.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Main run executor
// ---------------------------------------------------------------------------

export async function executeRun(job: RunJob): Promise<void> {
  await db
    .update(schema.runs)
    .set({ status: "running", started_at: new Date() })
    .where(eq(schema.runs.id, job.run_id));

  await emitEvent(db, job.run_id, "run_started", "Run started");

  // Already-deployed agents: run calls directly in worker process
  const isPlatformAdapter =
    job.adapter === "vapi" ||
    job.adapter === "retell" ||
    job.adapter === "elevenlabs" ||
    job.adapter === "bland" ||
    job.adapter === "livekit";
  const isRemote =
    isPlatformAdapter ||
    !!job.agent_url;
  if (isRemote) {
    await emitEvent(db, job.run_id, "connecting", `Connecting to remote agent (${job.adapter ?? "websocket"})...`);
    return executeRemoteRun(db, job);
  }

  // Local agent via agent session relay
  if (!job.agent_session_id) {
    await db
      .update(schema.runs)
      .set({ status: "fail", finished_at: new Date(), error_text: "Missing agent_session_id for local run" })
      .where(eq(schema.runs.id, job.run_id));
    return;
  }

  await emitEvent(db, job.run_id, "connecting", "Connecting to local agent via session relay...");

  let machineId: string;
  try {
    machineId = await getSessionMachineId(job.agent_session_id);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Session lookup failed";
    console.error(`Session lookup failed for ${job.run_id}:`, errorMessage);
    await db
      .update(schema.runs)
      .set({ status: "fail", finished_at: new Date(), error_text: errorMessage })
      .where(eq(schema.runs.id, job.run_id));
    return;
  }

  return executeSessionRun(db, job, machineId);
}
