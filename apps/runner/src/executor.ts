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
  onTestComplete?: (result: ConversationTestResult, testType: TestType) => void;
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
    concurrencyLimit = ["sip", "retell", "bland"].includes(channelConfig.adapter) ? 5 : 10,
    onTestStart,
    onTestComplete,
  } = opts;

  // Determine which test type is active (XOR — only one will be populated)
  const isRedTeam = (testSpec.red_team_tests?.length ?? 0) > 0;
  const testType: TestType = isRedTeam ? "red_team" : "conversation";
  const testSpecs = isRedTeam ? testSpec.red_team_tests! : (testSpec.conversation_tests ?? []);

  // Expand tests by repeat count for statistical confidence
  const allTests = testSpecs.flatMap((spec) => {
    const repeatCount = spec.repeat ?? 1;
    return Array.from({ length: repeatCount }, () => spec);
  });

  // Pre-flight health check — verify agent is reachable before running N tests
  if (allTests.length > 0) {
    const probeChannel = createAudioChannel(channelConfig);
    try {
      await probeChannel.connect();
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
      onTestComplete?.(failResult, testType);
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
      await channel.connect();
      const result = await runConversationTest(spec, channel);
      // Successful connection — reset circuit breaker counter
      circuitState.consecutiveConnectionFailures = 0;
      console.log(`    Status: ${result.status} (${result.duration_ms}ms)`);
      console.log(JSON.stringify({
        event: "test_complete", test_name: testName, test_type: testType,
        status: result.status, duration_ms: result.duration_ms,
        channel: { bytes_sent: channel.stats.bytesSent, bytes_received: channel.stats.bytesReceived, errors: channel.stats.errorEvents },
      }));
      onTestComplete?.(result, testType);
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
      onTestComplete?.(result, testType);
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

  const testCounts = { total: results.length, passed: completed, failed: errored };
  const aggregate: RunAggregateV2 = {
    conversation_tests: isRedTeam ? { total: 0, passed: 0, failed: 0 } : testCounts,
    ...(isRedTeam ? { red_team_tests: testCounts } : {}),
    total_duration_ms: totalDurationMs,
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
