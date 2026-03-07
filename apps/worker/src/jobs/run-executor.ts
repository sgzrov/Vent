import { eq } from "drizzle-orm";
import { createDb, schema, type Database } from "@voiceci/db";
import { RUNNER_CALLBACK_HEADER } from "@voiceci/shared";
import type {
  TestSpec,
  AdapterType,
  VoiceConfig,
  PlatformConfig,
} from "@voiceci/shared";
import type { AudioChannelConfig } from "@voiceci/adapters";
import { executeTests, expandRedTeamTests } from "@voiceci/runner/executor";

// ---------------------------------------------------------------------------
// Event emission — writes to DB and notifies API for SSE/MCP broadcast
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
    const apiUrl = process.env["API_URL"] ?? "https://voiceci-api.fly.dev";
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
  bundle_key: string | null;
  bundle_hash: string | null;
  lockfile_hash: string | null;
  adapter?: string;
  test_spec?: Record<string, unknown>;
  target_phone_number?: string;
  voice_config?: Record<string, unknown>;
  start_command?: string;
  health_endpoint?: string;
  agent_url?: string;
  platform?: PlatformConfig | null;
  relay?: boolean;
}

// ---------------------------------------------------------------------------
// Direct execution for already-deployed agents (SIP, WebRTC, agent_url)
// ---------------------------------------------------------------------------

async function executeRemoteRun(db: Database, job: RunJob): Promise<void> {
  const apiUrl = process.env["API_URL"] ?? "https://voiceci-api.fly.dev";
  const callbackSecret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  const callbackUrl = `${apiUrl}/internal/runner-callback`;

  const adapterType = (job.adapter ?? "websocket") as AdapterType;
  const agentUrl = job.agent_url ?? "http://localhost:3001";

  // Parse voice config
  let voiceConfig: VoiceConfig | undefined;
  if (job.voice_config) {
    voiceConfig = (job.voice_config as { voice?: VoiceConfig }).voice ?? undefined;
  }

  const channelConfig: AudioChannelConfig = {
    adapter: adapterType,
    agentUrl,
    targetPhoneNumber: job.target_phone_number,
    voice: voiceConfig,
    platform: job.platform ?? undefined,
  };

  const testSpec = job.test_spec as TestSpec;
  const redTeamExpanded = testSpec.red_team ? expandRedTeamTests(testSpec.red_team).length : 0;
  const totalTests = (testSpec.conversation_tests ?? []).reduce(
    (sum, t) => sum + ((t as { repeat?: number }).repeat ?? 1), 0
  ) + redTeamExpanded;
  let completedTests = 0;

  try {
    const { status, conversationResults, aggregate } = await executeTests({
      testSpec,
      channelConfig,
      onTestComplete: async (result) => {
        completedTests++;
        const testName = result.name ?? "conversation";

        try {
          await db.insert(schema.scenarioResults).values({
            run_id: job.run_id,
            name: testName,
            status: result.status,
            test_type: "conversation" as const,
            metrics_json: result as unknown as Record<string, unknown>,
            trace_json: result.transcript ?? [],
          });
        } catch {
          // Best-effort
        }

        void fetch(`${apiUrl}/internal/test-progress`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [RUNNER_CALLBACK_HEADER]: callbackSecret,
          },
          body: JSON.stringify({
            run_id: job.run_id,
            completed: completedTests,
            total: totalTests,
            test_type: "conversation",
            test_name: testName,
            status: result.status,
            duration_ms: result.duration_ms,
          }),
        }).catch(() => {});
      },
    });

    // POST results to callback (stores in DB + triggers SSE push)
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
// Relay execution — tests run in worker, audio flows through relay to local agent
// ---------------------------------------------------------------------------

async function executeRelayRun(db: Database, job: RunJob): Promise<void> {
  const apiUrl = process.env["API_URL"] ?? "https://voiceci-api.fly.dev";
  const callbackSecret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  const callbackUrl = `${apiUrl}/internal/runner-callback`;

  // Build relay connect URL — the WsAudioChannel will append conn_id automatically
  const relayWsUrl = apiUrl.replace(/^http/, "ws") + `/relay/connect?run_id=${job.run_id}`;

  const channelConfig: AudioChannelConfig = {
    adapter: "websocket",
    agentUrl: relayWsUrl,
    targetPhoneNumber: job.target_phone_number,
  };

  const testSpec = job.test_spec as TestSpec;
  const redTeamExpanded = testSpec.red_team ? expandRedTeamTests(testSpec.red_team).length : 0;
  const totalTests = (testSpec.conversation_tests ?? []).reduce(
    (sum, t) => sum + ((t as { repeat?: number }).repeat ?? 1), 0
  ) + redTeamExpanded;
  let completedTests = 0;

  try {
    const { status, conversationResults, aggregate } = await executeTests({
      testSpec,
      channelConfig,
      onTestComplete: async (result) => {
        completedTests++;
        const testName = result.name ?? "conversation";

        try {
          await db.insert(schema.scenarioResults).values({
            run_id: job.run_id,
            name: testName,
            status: result.status,
            test_type: "conversation" as const,
            metrics_json: result as unknown as Record<string, unknown>,
            trace_json: result.transcript ?? [],
          });
        } catch {
          // Best-effort
        }

        void fetch(`${apiUrl}/internal/test-progress`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [RUNNER_CALLBACK_HEADER]: callbackSecret,
          },
          body: JSON.stringify({
            run_id: job.run_id,
            completed: completedTests,
            total: totalTests,
            test_type: "conversation",
            test_name: testName,
            status: result.status,
            duration_ms: result.duration_ms,
          }),
        }).catch(() => {});
      },
    });

    // Notify relay client that the run is complete
    void fetch(`${apiUrl}/internal/relay-complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RUNNER_CALLBACK_HEADER]: callbackSecret,
      },
      body: JSON.stringify({ run_id: job.run_id }),
    }).catch(() => {});

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

    console.log(`Relay run ${job.run_id} completed: ${status}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`Relay run ${job.run_id} failed:`, errorMessage);

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
// Main run executor
// ---------------------------------------------------------------------------

export async function executeRun(job: RunJob): Promise<void> {

  await db
    .update(schema.runs)
    .set({ status: "running", started_at: new Date() })
    .where(eq(schema.runs.id, job.run_id));

  await emitEvent(db, job.run_id, "run_started", "Run started");

  // Already-deployed agents: run tests directly in worker process
  const isPlatformAdapter =
    job.adapter === "vapi" ||
    job.adapter === "retell" ||
    job.adapter === "elevenlabs" ||
    job.adapter === "bland";
  const isRemote =
    isPlatformAdapter ||
    job.adapter === "sip" ||
    job.adapter === "webrtc" ||
    !!job.agent_url;
  if (isRemote) {
    await emitEvent(db, job.run_id, "connecting", `Connecting to remote agent (${job.adapter ?? "websocket"})...`);
    return executeRemoteRun(db, job);
  }

  // Local WebSocket agent — route through relay
  await emitEvent(db, job.run_id, "connecting", "Connecting to local agent via relay tunnel...");
  return executeRelayRun(db, job);
}
