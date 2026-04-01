/**
 * Test execution logic — conversation and red team tests run in parallel with a concurrency limiter.
 * Audio quality analysis, latency drift, and echo detection are integrated
 * into each test (no standalone infrastructure probes).
 */

import type {
  TestSpec,
  ConversationTestResult,
  RunAggregateV2,
} from "@vent/shared";
import { createAudioChannel, type AudioChannelConfig } from "@vent/adapters";
import { runConversationTest } from "./conversation/index.js";

export type TestType = "conversation" | "red_team";

export interface TestStartInfo {
  test_name: string;
  test_type: TestType;
}

export interface ExecuteTestsOpts {
  testSpec: TestSpec;
  channelConfig: AudioChannelConfig;
  concurrencyLimit?: number;
  onTestStart?: (info: TestStartInfo) => void;
  onTestComplete?: (result: ConversationTestResult, testType: TestType) => void | Promise<void>;
}

export interface ExecuteTestsResult {
  status: "pass" | "fail";
  conversationResults: ConversationTestResult[];
  redTeamResults: ConversationTestResult[];
  aggregate: RunAggregateV2;
}

/**
 * Circuit breaker state — shared across all concurrent workers.
 * Aborts the run after consecutive connection failures to avoid
 * N identical timeouts when the agent is unreachable.
 */
interface ConcurrencyState {
  aborted: boolean;
  abortReason: string | null;
  consecutiveConnectionFailures: number;
}

const CONNECTION_ERROR_PATTERNS = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "WebSocket",
  "websocket",
  "connect",
  "Agent unreachable",
];

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CONNECTION_ERROR_PATTERNS.some((p) => msg.includes(p));
}

const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Run a set of concurrency-limited tasks, returning results in completion order.
 * Supports circuit breaker — if state.aborted is set, remaining tasks are skipped.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  state?: ConcurrencyState,
  onAbort?: () => T,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function next(): Promise<void> {
    while (index < tasks.length) {
      if (state?.aborted && onAbort) {
        const currentIndex = index++;
        results[currentIndex] = onAbort();
        continue;
      }
      const currentIndex = index++;
      results[currentIndex] = await tasks[currentIndex]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

export async function executeTests(opts: ExecuteTestsOpts): Promise<ExecuteTestsResult> {
  const {
    testSpec,
    channelConfig,
    concurrencyLimit: userConcurrency,
    onTestStart,
    onTestComplete,
  } = opts;

  // Bland uses SIP (phone calls) instead of WebSocket/WebRTC. All calls route
  // through a single Twilio number, and Bland drops later calls when 3+ are
  // active on the same destination. Cap at 3 concurrent for reliability.
  // To scale beyond 3, rotate Twilio destination numbers (number pool).
  const isBland = channelConfig.adapter === "bland";
  const concurrencyLimit = userConcurrency ?? (isBland ? 3 : 10);

  // Determine which test type is active (XOR — only one will be populated)
  const isRedTeam = (testSpec.red_team_tests?.length ?? 0) > 0;
  const testType: TestType = isRedTeam ? "red_team" : "conversation";
  const testSpecs = isRedTeam ? testSpec.red_team_tests! : (testSpec.conversation_tests ?? []);
  const notifyTestComplete = async (result: ConversationTestResult) => {
    if (!onTestComplete) return;
    try {
      await onTestComplete(result, testType);
    } catch (err) {
      console.warn(`onTestComplete failed: ${(err as Error).message}`);
    }
  };

  // Expand tests by repeat count for statistical confidence
  const allTests = testSpecs.flatMap((spec) => {
    const repeatCount = spec.repeat ?? 1;
    return Array.from({ length: repeatCount }, () => spec);
  });

  // Pre-flight health check — only for relay/local agent runs.
  // Platform adapters (vapi, retell, elevenlabs, bland) don't need this —
  // it would waste a real API call + credits just to verify connectivity.
  // The first real test will fail with a clear error if config is wrong.
  const isPlatformAdapter = ["vapi", "retell", "elevenlabs", "bland", "livekit"].includes(channelConfig.adapter);
  if (allTests.length > 0 && !isPlatformAdapter) {
    const probeChannel = createAudioChannel(channelConfig);
    try {
      await probeChannel.connect();
      // Hold open to verify end-to-end — if the CLI can't reach the agent,
      // the API closes this WS within ~1s (close message or buffer limit).
      await new Promise<void>((resolve, reject) => {
        const ok = setTimeout(() => {
          probeChannel.off("disconnected", onDisconnect);
          resolve();
        }, 2_000);
        function onDisconnect() {
          clearTimeout(ok);
          reject(new Error("Relay probe disconnected — CLI cannot reach local agent"));
        }
        if (!probeChannel.connected) {
          clearTimeout(ok);
          reject(new Error("Relay probe closed immediately — CLI cannot reach local agent"));
          return;
        }
        probeChannel.on("disconnected", onDisconnect);
      });
      await probeChannel.disconnect().catch(() => {});
      console.log("Pre-flight health check passed — agent is reachable.");
    } catch (err) {
      await probeChannel.disconnect().catch(() => {});
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Pre-flight health check failed: ${errorMsg}`);
      const failResult: ConversationTestResult = {
        name: "health_check",
        caller_prompt: "Pre-flight connectivity check",
        status: "error",
        transcript: [],
        duration_ms: 0,
        metrics: { mean_ttfb_ms: 0 },
        error: `Agent unreachable: ${errorMsg}`,
      };
      await notifyTestComplete(failResult);
      const aggregateKey = isRedTeam ? "red_team_tests" : "conversation_tests";
      return {
        status: "fail" as const,
        conversationResults: isRedTeam ? [] : [failResult],
        redTeamResults: isRedTeam ? [failResult] : [],
        aggregate: {
          conversation_tests: { total: 0, passed: 0, failed: 0 },
          ...(isRedTeam
            ? { red_team_tests: { total: 1, passed: 0, failed: 1 } }
            : { conversation_tests: { total: 1, passed: 0, failed: 1 } }
          ),
          total_duration_ms: 0,
        },
      };
    }
  }

  // Circuit breaker state — shared across concurrent workers
  const circuitState: ConcurrencyState = {
    aborted: false,
    abortReason: null,
    consecutiveConnectionFailures: 0,
  };

  const testLabel = isRedTeam ? "Red team" : "Conversation";

  const tasks = allTests.map((spec) => async () => {
    const testName = spec.name ?? `${testType}:${spec.caller_prompt.slice(0, 50)}`;
    onTestStart?.({ test_name: testName, test_type: testType });
    console.log(`  ${testLabel}: ${spec.caller_prompt.slice(0, 60)}...`);

    const channel = createAudioChannel(channelConfig);
    const start = Date.now();
    try {
      // Per-test timeout: scales with max_turns to accommodate agents that
      // use tool calls (each turn can take 15-20s with STT → LLM → tools → TTS).
      // Minimum 120s, plus 25s per turn beyond the baseline 4 turns.
      const TEST_TIMEOUT_MS = Math.max(120_000, (spec.max_turns ?? 10) * 25_000);
      const testResult = await Promise.race([
        (async () => {
          await channel.connect();
          return await runConversationTest(spec, channel);
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(
            `Test "${testName}" timed out after ${TEST_TIMEOUT_MS / 1000}s. ` +
            `The agent may have connected but not produced audio.`
          )), TEST_TIMEOUT_MS)
        ),
      ]);
      const result = testResult;
      // Successful connection — reset circuit breaker counter
      circuitState.consecutiveConnectionFailures = 0;
      console.log(`    Status: ${result.status} (${result.duration_ms}ms)`);
      console.log(JSON.stringify({
        event: "test_complete", test_name: testName, test_type: testType,
        status: result.status, duration_ms: result.duration_ms,
        channel: { bytes_sent: channel.stats.bytesSent, bytes_received: channel.stats.bytesReceived, errors: channel.stats.errorEvents },
      }));
      await notifyTestComplete(result);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`    ${testName}: error — ${errorMsg}`);

      // Circuit breaker: track consecutive connection errors
      if (isConnectionError(err)) {
        circuitState.consecutiveConnectionFailures++;
        if (circuitState.consecutiveConnectionFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          circuitState.aborted = true;
          circuitState.abortReason = `Run aborted after ${CIRCUIT_BREAKER_THRESHOLD} consecutive connection failures: ${errorMsg}`;
          console.error(`Circuit breaker tripped: ${circuitState.abortReason}`);
        }
      } else {
        // Non-connection error (eval/logic failure) — reset counter
        circuitState.consecutiveConnectionFailures = 0;
      }

      const result: ConversationTestResult = {
        name: spec.name,
        caller_prompt: spec.caller_prompt,
        status: "error",
        transcript: [],
        duration_ms: Date.now() - start,
        metrics: { mean_ttfb_ms: 0 },
        error: errorMsg,
      };
      console.log(JSON.stringify({
        event: "test_complete", test_name: testName, test_type: testType,
        status: "error", duration_ms: result.duration_ms, error: errorMsg,
      }));
      await notifyTestComplete(result);
      return result;
    } finally {
      await channel.disconnect().catch(() => {});
    }
  });

  if (tasks.length > 0) {
    console.log(`Running ${tasks.length} ${testLabel.toLowerCase()} tests (concurrency: ${concurrencyLimit})...`);
  }

  // Build an abort result factory for the circuit breaker
  const makeAbortResult = (): ConversationTestResult => ({
    name: "aborted",
    caller_prompt: "Skipped — circuit breaker tripped",
    status: "error",
    transcript: [],
    duration_ms: 0,
    metrics: { mean_ttfb_ms: 0 },
    error: circuitState.abortReason ?? "Run aborted",
  });

  const results = tasks.length > 0
    ? await runWithConcurrency(tasks, concurrencyLimit, circuitState, makeAbortResult)
    : [];

  // =====================================================
  // Aggregate results
  // =====================================================
  const completed = results.filter((r) => r.status === "completed").length;
  const errored = results.filter((r) => r.status === "error").length;
  const totalDurationMs = results.reduce((sum, r) => sum + r.duration_ms, 0);

  // Sum platform costs across all tests
  const totalCostUsd = results.reduce((sum, r) => {
    const cost = r.call_metadata?.cost_usd;
    return cost != null ? sum + cost : sum;
  }, 0);

  const testCounts = { total: results.length, passed: completed, failed: errored };
  const aggregate: RunAggregateV2 = {
    conversation_tests: isRedTeam ? { total: 0, passed: 0, failed: 0 } : testCounts,
    ...(isRedTeam ? { red_team_tests: testCounts } : {}),
    total_duration_ms: totalDurationMs,
    ...(totalCostUsd > 0 ? { total_cost_usd: totalCostUsd } : {}),
  };

  const status = errored === 0 ? "pass" : "fail";

  console.log(
    `Run complete: ${status} (${testLabel.toLowerCase()}: ${completed}/${results.length})`,
  );

  return {
    status,
    conversationResults: isRedTeam ? [] : results,
    redTeamResults: isRedTeam ? results : [],
    aggregate,
  };
}
