import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import { createDb, schema, type Database } from "@vent/db";
import { RUNNER_CALLBACK_HEADER } from "@vent/shared";
import type {
  TestSpec,
  LoadTestResult,
  LoadTestTierResult,
  AdapterType,
  PlatformConfig,
} from "@vent/shared";
import type { AudioChannelConfig } from "@vent/adapters";
import { executeTests } from "@vent/runner/executor";
import { runLoadTest, computeTierSizes } from "@vent/runner/load-test";

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
// Load test execution — runs after conversation tests if load_test spec exists
// ---------------------------------------------------------------------------

async function executeLoadTestPhase(
  db: Database,
  job: RunJob,
  channelConfig: AudioChannelConfig,
  apiUrl: string,
  callbackSecret: string,
): Promise<{ loadTestResult: LoadTestResult } | null> {
  const testSpec = job.test_spec as TestSpec;
  const loadSpec = testSpec.load_test;
  if (!loadSpec) return null;

  await emitEvent(db, job.run_id, "load_test_started", `Starting load test — target concurrency: ${loadSpec.target_concurrency}`);

  const phaseCount = computeTierSizes(loadSpec.target_concurrency, loadSpec.ramps).length
    + (loadSpec.spike_multiplier ? 1 : 0)
    + (loadSpec.soak_duration_min ? 1 : 0);

  let tierCount = 0;
  const result = await runLoadTest({
    channelConfig,
    targetConcurrency: loadSpec.target_concurrency,
    callerPrompt: loadSpec.caller_prompt,
    callerPrompts: loadSpec.caller_prompts,
    maxTurns: loadSpec.max_turns,
    ramps: loadSpec.ramps,
    thresholds: loadSpec.thresholds,
    callerAudioPool: loadSpec.caller_audio,
    language: loadSpec.language,
    spikeMultiplier: loadSpec.spike_multiplier,
    soakDurationMin: loadSpec.soak_duration_min,
    onTierComplete: async (tier: LoadTestTierResult) => {
      tierCount++;
      const tierName = tier.phase === "spike"
        ? "load-test:spike"
        : tier.phase === "soak"
          ? "load-test:soak"
          : `load-test:tier-${tier.concurrency}`;

      void fetch(`${apiUrl}/internal/test-progress`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [RUNNER_CALLBACK_HEADER]: callbackSecret,
        },
        body: JSON.stringify({
          run_id: job.run_id,
          completed: tierCount,
          total: phaseCount,
          test_type: "load_test",
          test_name: tierName,
          status: tier.failed_calls > 0 ? "fail" : "pass",
          duration_ms: tier.duration_ms,
        }),
      }).catch(() => {});
    },
  });

  return { loadTestResult: result };
}

// ---------------------------------------------------------------------------
// Direct execution for already-deployed agents (SIP, WebRTC, agent_url)
// ---------------------------------------------------------------------------

async function executeRemoteRun(db: Database, job: RunJob): Promise<void> {
  const apiUrl = process.env["API_URL"] ?? "https://vent-api.fly.dev";
  const callbackSecret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  const callbackUrl = `${apiUrl}/internal/runner-callback`;

  const adapterType = (job.adapter ?? "websocket") as AdapterType;
  const agentUrl = job.agent_url ?? "http://localhost:3001";

  const channelConfig: AudioChannelConfig = {
    adapter: adapterType,
    agentUrl,
    targetPhoneNumber: job.target_phone_number,
    platform: job.platform ?? undefined,
  };

  const testSpec = job.test_spec as TestSpec;
  const totalTests = (testSpec.conversation_tests ?? []).reduce(
    (sum, t) => sum + ((t as { repeat?: number }).repeat ?? 1), 0
  );
  let completedTests = 0;

  try {
    if (testSpec.load_test) {
      // Load test run
      const loadResult = await executeLoadTestPhase(db, job, channelConfig, apiUrl, callbackSecret);
      const status = loadResult!.loadTestResult.status;

      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [RUNNER_CALLBACK_HEADER]: callbackSecret,
        },
        body: JSON.stringify({
          run_id: job.run_id,
          status,
          conversation_results: [],
          aggregate: {},
          load_test_result: loadResult!.loadTestResult,
        }),
      });

      if (!response.ok) {
        throw new Error(`Callback failed: ${response.status} ${await response.text()}`);
      }

      console.log(`Remote load test ${job.run_id} completed: ${status}`);
    } else {
      // Conversation test run
      const { status, conversationResults, aggregate } = await executeTests({
        testSpec,
        channelConfig,
        onTestComplete: async (result) => {
          completedTests++;
          const testName = result.name ?? "conversation";

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
    }
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

async function executeRelayRun(db: Database, job: RunJob, relayMachineId?: string): Promise<void> {
  const apiUrl = process.env["API_URL"] ?? "https://vent-api.fly.dev";
  const callbackSecret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  const callbackUrl = `${apiUrl}/internal/runner-callback`;

  // Build relay connect URL — the WsAudioChannel will append conn_id automatically
  const relayWsUrl = apiUrl.replace(/^http/, "ws") + `/relay/connect?run_id=${job.run_id}`;

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
    targetPhoneNumber: job.target_phone_number,
    relayHeaders,
  };

  const testSpec = job.test_spec as TestSpec;
  const totalTests = (testSpec.conversation_tests ?? []).reduce(
    (sum, t) => sum + ((t as { repeat?: number }).repeat ?? 1), 0
  );
  let completedTests = 0;

  try {
    // Notify relay complete helper
    const notifyRelayComplete = () => {
      void fetch(`${apiUrl}/internal/relay-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [RUNNER_CALLBACK_HEADER]: callbackSecret },
        body: JSON.stringify({ run_id: job.run_id }),
      }).catch(() => {});
    };

    if (testSpec.load_test) {
      // Load test run
      const loadResult = await executeLoadTestPhase(db, job, channelConfig, apiUrl, callbackSecret);
      const status = loadResult!.loadTestResult.status;

      notifyRelayComplete();

      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", [RUNNER_CALLBACK_HEADER]: callbackSecret },
        body: JSON.stringify({
          run_id: job.run_id,
          status,
          conversation_results: [],
          aggregate: {},
          load_test_result: loadResult!.loadTestResult,
        }),
      });

      if (!response.ok) {
        throw new Error(`Callback failed: ${response.status} ${await response.text()}`);
      }

      console.log(`Relay load test ${job.run_id} completed: ${status}`);
    } else {
      // Conversation test run
      const { status, conversationResults, aggregate } = await executeTests({
        testSpec,
        channelConfig,
        onTestComplete: async (result) => {
          completedTests++;
          const testName = result.name ?? "conversation";

          void fetch(`${apiUrl}/internal/test-progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json", [RUNNER_CALLBACK_HEADER]: callbackSecret },
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

      notifyRelayComplete();

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

      console.log(`Relay run ${job.run_id} completed: ${status}`);
    }
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
// Wait for relay tunnel to be established before running tests
// Uses Redis pub/sub — instant notification, no HTTP polling
// ---------------------------------------------------------------------------

async function waitForRelayReady(runId: string, timeoutMs = 90_000): Promise<string> {
  // Direct Redis key poll — no HTTP, no load balancer, no in-memory session map.
  // The API sets `vent:relay-session:{runId}` in Redis when the relay WebSocket connects.
  // We just check that key directly. Simple, reliable, no race conditions.
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const key = `vent:relay-session:${runId}`;

  try {
    console.log(`[relay-wait] ${runId}: starting poll — redis=${redisUrl.replace(/\/\/.*@/, "//***@")} key=${key}`);
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;
    while (Date.now() < deadline) {
      pollCount++;
      try {
        const ready = await redis.get(key);
        if (pollCount <= 5 || pollCount % 10 === 0) {
          console.log(`[relay-wait] ${runId}: poll #${pollCount} result=${JSON.stringify(ready)}`);
        }
        if (ready) {
          console.log(`[relay-wait] ${runId}: relay ready after ${pollCount} polls (machine=${ready})`);
          return ready;
        }
      } catch (err) {
        console.error(`[relay-wait] ${runId}: poll #${pollCount} Redis GET error:`, err);
      }
      await new Promise(r => setTimeout(r, 1_000));
    }
    console.error(`[relay-wait] ${runId}: TIMEOUT after ${pollCount} polls (${timeoutMs}ms)`);
    throw new Error("Relay connection timeout — local agent relay did not connect within 90s");
  } finally {
    redis.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Main run executor
// ---------------------------------------------------------------------------

export async function executeRun(job: RunJob): Promise<void> {

  // For relay runs, wait for the relay tunnel before starting tests
  let relayMachineId: string | undefined;
  if (job.relay) {
    await emitEvent(db, job.run_id, "waiting_for_relay", "Waiting for local agent relay tunnel to connect...");
    try {
      relayMachineId = await waitForRelayReady(job.run_id);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Relay timeout";
      console.error(`Relay wait failed for ${job.run_id}:`, errorMessage);
      await db
        .update(schema.runs)
        .set({ status: "fail", finished_at: new Date(), error_text: errorMessage })
        .where(eq(schema.runs.id, job.run_id));
      return;
    }
  }

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
  return executeRelayRun(db, job, relayMachineId);
}
