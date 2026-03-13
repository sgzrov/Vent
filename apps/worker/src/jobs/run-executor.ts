import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import { createDb, schema, type Database } from "@voiceci/db";
import { RUNNER_CALLBACK_HEADER } from "@voiceci/shared";
import type {
  TestSpec,
  LoadTestSpec,
  LoadTestResult,
  LoadTestTierResult,
  AdapterType,
  PlatformConfig,
} from "@voiceci/shared";
import type { AudioChannelConfig } from "@voiceci/adapters";
import { executeTests } from "@voiceci/runner/executor";
import { runLoadTest } from "@voiceci/runner/load-test";

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

  let tierCount = 0;
  const result = await runLoadTest({
    channelConfig,
    targetConcurrency: loadSpec.target_concurrency,
    callerPrompt: loadSpec.caller_prompt,
    maxTurns: loadSpec.max_turns,
    evalQuestions: loadSpec.eval,
    thresholds: loadSpec.thresholds,
    callerAudioPool: loadSpec.caller_audio,
    language: loadSpec.language,
    onTierComplete: async (tier: LoadTestTierResult) => {
      tierCount++;
      const tierName = `load-test:tier-${tier.concurrency}`;

      try {
        await db.insert(schema.scenarioResults).values({
          run_id: job.run_id,
          name: tierName,
          status: tier.failed_calls > 0 ? "fail" : "pass",
          test_type: "load_test" as const,
          metrics_json: tier as unknown as Record<string, unknown>,
          trace_json: {},
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
          completed: tierCount,
          total: 4,
          test_type: "load_test",
          test_name: tierName,
          status: tier.failed_calls > 0 ? "fail" : "pass",
          duration_ms: tier.duration_ms,
        }),
      }).catch(() => {});
    },
  });

  // Insert final load test summary
  try {
    await db.insert(schema.scenarioResults).values({
      run_id: job.run_id,
      name: "load-test:summary",
      status: result.status,
      test_type: "load_test" as const,
      metrics_json: result as unknown as Record<string, unknown>,
      trace_json: {},
    });
  } catch {
    // Best-effort
  }

  return { loadTestResult: result };
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

async function waitForRelayReady(runId: string, timeoutMs = 90_000): Promise<void> {
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const sub = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const channel = `voiceci:relay-ready:${runId}`;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const timeout = setTimeout(() => {
        settle(() => {
          sub.unsubscribe(channel).catch(() => {});
          sub.disconnect();
          reject(new Error("Relay connection timeout — local agent relay did not connect within 90s"));
        });
      }, timeoutMs);

      sub.on("message", () => {
        settle(() => {
          clearTimeout(timeout);
          sub.unsubscribe(channel).catch(() => {});
          sub.disconnect();
          resolve();
        });
      });

      sub.subscribe(channel, (err) => {
        if (err) {
          settle(() => {
            clearTimeout(timeout);
            sub.disconnect();
            reject(err);
          });
          return;
        }

        // Race condition guard: relay may have connected before we subscribed.
        // One HTTP check right after subscribe — if already ready, resolve immediately.
        const apiUrl = process.env["API_URL"] ?? "https://voiceci-api.fly.dev";
        const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
        fetch(`${apiUrl}/internal/relay-ready/${runId}`, {
          headers: { [RUNNER_CALLBACK_HEADER]: secret },
        })
          .then((res) => {
            if (res.ok) {
              settle(() => {
                clearTimeout(timeout);
                sub.unsubscribe(channel).catch(() => {});
                sub.disconnect();
                resolve();
              });
            }
          })
          .catch(() => {
            // Not ready yet — wait for pub/sub message
          });
      });
    });
  } catch (err) {
    sub.disconnect();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main run executor
// ---------------------------------------------------------------------------

export async function executeRun(job: RunJob): Promise<void> {

  // For relay runs, wait for the relay tunnel before starting tests
  if (job.relay) {
    await emitEvent(db, job.run_id, "waiting_for_relay", "Waiting for local agent relay tunnel to connect...");
    try {
      await waitForRelayReady(job.run_id);
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
  return executeRelayRun(db, job);
}
