/**
 * Test execution logic — conversation tests run in parallel with a concurrency limiter.
 * Audio quality analysis, latency drift, and echo detection are integrated
 * into each conversation test (no standalone infrastructure probes).
 */

import type {
  TestSpec,
  ConversationTestResult,
  RunAggregateV2,
} from "@voiceci/shared";
import { createAudioChannel, type AudioChannelConfig } from "@voiceci/adapters";
import { runConversationTest } from "./conversation/index.js";

export interface TestStartInfo {
  test_name: string;
  test_type: "conversation";
}

export interface ExecuteTestsOpts {
  testSpec: TestSpec;
  channelConfig: AudioChannelConfig;
  concurrencyLimit?: number;
  onTestStart?: (info: TestStartInfo) => void;
  onTestComplete?: (result: ConversationTestResult) => void;
}

export interface ExecuteTestsResult {
  status: "pass" | "fail";
  conversationResults: ConversationTestResult[];
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

  // =====================================================
  // Conversation tests (concurrent)
  // Audio quality, latency drift, and echo detection are
  // integrated into each conversation test automatically.
  // =====================================================
  // Expand conversation tests by repeat count for statistical confidence
  const allConversationTests = (testSpec.conversation_tests ?? []).flatMap((spec) => {
    const repeatCount = spec.repeat ?? 1;
    return Array.from({ length: repeatCount }, () => spec);
  });

  // Pre-flight health check — verify agent is reachable before running N tests
  if (allConversationTests.length > 0) {
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
        status: "fail",
        transcript: [],
        eval_results: [],
        duration_ms: 0,
        metrics: { mean_ttfb_ms: 0 },
        error: `Agent unreachable: ${errorMsg}`,
        diagnostics: {
          error_origin: "platform",
          error_detail: `Pre-flight health check failed: ${errorMsg}`,
          timing: { channel_connect_ms: probeChannel.stats.connectLatencyMs },
          channel: {
            connected: false,
            error_events: probeChannel.stats.errorEvents,
            audio_bytes_sent: 0,
            audio_bytes_received: 0,
          },
        },
      };
      onTestComplete?.(failResult);
      return {
        status: "fail" as const,
        conversationResults: [failResult],
        aggregate: {
          conversation_tests: { total: 1, passed: 0, failed: 1 },
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

  const conversationTasks = allConversationTests.map((spec) => async () => {
    const testName = spec.name ?? `conversation:${spec.caller_prompt.slice(0, 50)}`;
    onTestStart?.({ test_name: testName, test_type: "conversation" });
    console.log(`  Conversation: ${spec.caller_prompt.slice(0, 60)}...`);
    const channel = createAudioChannel(channelConfig);
    const start = Date.now();
    try {
      await channel.connect();
      const result = await runConversationTest(spec, channel);
      // Successful connection — reset circuit breaker counter
      circuitState.consecutiveConnectionFailures = 0;
      console.log(`    Status: ${result.status} (${result.duration_ms}ms)`);
      console.log(JSON.stringify({
        event: "test_complete", test_name: testName, test_type: "conversation",
        status: result.status, duration_ms: result.duration_ms,
        error_origin: result.diagnostics?.error_origin ?? null,
        channel: { bytes_sent: channel.stats.bytesSent, bytes_received: channel.stats.bytesReceived, errors: channel.stats.errorEvents },
      }));
      onTestComplete?.(result);
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
        status: "fail",
        transcript: [],
        eval_results: [],
        duration_ms: Date.now() - start,
        metrics: { mean_ttfb_ms: 0 },
        error: errorMsg,
        diagnostics: {
          error_origin: "platform",
          error_detail: errorMsg,
          timing: { channel_connect_ms: channel.stats.connectLatencyMs },
          channel: {
            connected: channel.connected,
            error_events: channel.stats.errorEvents,
            audio_bytes_sent: channel.stats.bytesSent,
            audio_bytes_received: channel.stats.bytesReceived,
          },
        },
      };
      console.log(JSON.stringify({
        event: "test_complete", test_name: testName, test_type: "conversation",
        status: "fail", duration_ms: result.duration_ms,
        error_origin: "platform", error_detail: errorMsg,
      }));
      onTestComplete?.(result);
      return result;
    } finally {
      await channel.disconnect().catch(() => {});
    }
  });

  if (conversationTasks.length > 0) {
    console.log(`Running ${conversationTasks.length} conversation tests (concurrency: ${concurrencyLimit})...`);
  }

  // Build an abort result factory for the circuit breaker
  const makeAbortResult = (): ConversationTestResult => ({
    name: "aborted",
    caller_prompt: "Skipped — circuit breaker tripped",
    status: "fail",
    transcript: [],
    eval_results: [],
    duration_ms: 0,
    metrics: { mean_ttfb_ms: 0 },
    error: circuitState.abortReason ?? "Run aborted",
    diagnostics: {
      error_origin: "platform",
      error_detail: circuitState.abortReason ?? "Run aborted due to consecutive connection failures",
      timing: { channel_connect_ms: 0 },
      channel: { connected: false, error_events: [], audio_bytes_sent: 0, audio_bytes_received: 0 },
    },
  });

  const conversationResults = conversationTasks.length > 0
    ? await runWithConcurrency(conversationTasks, concurrencyLimit, circuitState, makeAbortResult)
    : [];

  // =====================================================
  // Aggregate results
  // =====================================================
  const convPassed = conversationResults.filter((r) => r.status === "pass").length;
  const convFailed = conversationResults.filter((r) => r.status === "fail").length;

  const totalDurationMs = conversationResults.reduce((sum, r) => sum + r.duration_ms, 0);

  const aggregate: RunAggregateV2 = {
    conversation_tests: { total: conversationResults.length, passed: convPassed, failed: convFailed },
    total_duration_ms: totalDurationMs,
  };

  const status = convFailed === 0 ? "pass" : "fail";

  console.log(
    `Run complete: ${status} (conversation: ${convPassed}/${conversationResults.length})`,
  );

  return { status, conversationResults, aggregate };
}
