/**
 * Test execution logic — Layer 1 infrastructure probes run first
 * (parallel for websocket/webrtc, sequential for platform adapters),
 * then conversation tests run in parallel with a concurrency limiter.
 */

import type {
  TestSpec,
  AudioTestResult,
  ConversationTestResult,
  RunAggregateV2,
  InfrastructureProbeConfig,
  AudioTestName,
  AUDIO_TEST_NAMES,
} from "@voiceci/shared";
import { createAudioChannel, type AudioChannelConfig } from "@voiceci/adapters";
import { runInfrastructureProbe } from "./audio-tests/index.js";
import { runConversationTest, expandRedTeamTests } from "./conversation/index.js";

// Re-export for consumers that import from @voiceci/runner/executor
export { expandRedTeamTests };

export interface TestStartInfo {
  test_name: string;
  test_type: "infrastructure" | "conversation";
}

export interface ExecuteTestsOpts {
  testSpec: TestSpec;
  channelConfig: AudioChannelConfig;
  concurrencyLimit?: number;
  onTestStart?: (info: TestStartInfo) => void;
  onTestComplete?: (result: AudioTestResult | ConversationTestResult) => void;
}

export interface ExecuteTestsResult {
  status: "pass" | "fail";
  infrastructureResults: AudioTestResult[];
  conversationResults: ConversationTestResult[];
  aggregate: RunAggregateV2;
}

/**
 * Run a set of concurrency-limited tasks, returning results in completion order.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function next(): Promise<void> {
    while (index < tasks.length) {
      const currentIndex = index++;
      results[currentIndex] = await tasks[currentIndex]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

/** All Layer 1 probe names */
const PROBE_NAMES: AudioTestName[] = ["audio_quality", "latency", "echo"];

export async function executeTests(opts: ExecuteTestsOpts): Promise<ExecuteTestsResult> {
  const {
    testSpec,
    channelConfig,
    concurrencyLimit = ["sip", "retell", "bland"].includes(channelConfig.adapter) ? 5 : 10,
    onTestStart,
    onTestComplete,
  } = opts;

  // =====================================================
  // Phase 1: Layer 1 — Infrastructure probes
  // Parallel (separate channels) for websocket/webrtc.
  // Sequential (shared channel) for platform adapters (rate limits/cost).
  // =====================================================
  const infrastructureResults: AudioTestResult[] = [];
  const isPlatformAdapter = ["vapi", "retell", "elevenlabs", "bland", "sip"].includes(channelConfig.adapter);

  if (testSpec.infrastructure) {
    if (isPlatformAdapter) {
      // Sequential — single channel, one probe at a time
      console.log("Running Layer 1 infrastructure probes (sequential)...");
      const channel = createAudioChannel(channelConfig);
      try {
        await channel.connect();

        for (const probeName of PROBE_NAMES) {
          onTestStart?.({ test_name: probeName, test_type: "infrastructure" });
          console.log(`  Infrastructure: ${probeName}`);

          const result = await runInfrastructureProbe(probeName, channel, testSpec.infrastructure);
          console.log(`    ${probeName}: ${result.status} (${result.duration_ms}ms)`);
          console.log(JSON.stringify({
            event: "test_complete", test_name: probeName, test_type: "infrastructure",
            status: result.status, duration_ms: result.duration_ms,
            error_origin: result.diagnostics?.error_origin ?? null,
            error_detail: result.diagnostics?.error_detail ?? null,
            channel: { bytes_sent: channel.stats.bytesSent, bytes_received: channel.stats.bytesReceived, errors: channel.stats.errorEvents },
          }));
          onTestComplete?.(result);
          infrastructureResults.push(result);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`  Infrastructure probe error: ${errorMsg}`);
        for (const probeName of PROBE_NAMES) {
          if (infrastructureResults.some((r) => r.test_name === probeName)) continue;
          const result: AudioTestResult = {
            test_name: probeName,
            status: "error",
            metrics: {},
            transcriptions: {},
            duration_ms: 0,
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
          onTestComplete?.(result);
          infrastructureResults.push(result);
        }
      } finally {
        await channel.disconnect().catch(() => {});
      }
    } else {
      // Parallel — separate channel per probe (websocket/webrtc)
      console.log("Running Layer 1 infrastructure probes (parallel)...");

      const probeResults = await Promise.all(
        PROBE_NAMES.map(async (probeName) => {
          onTestStart?.({ test_name: probeName, test_type: "infrastructure" });
          console.log(`  Infrastructure: ${probeName}`);
          const channel = createAudioChannel(channelConfig);
          try {
            await channel.connect();
            const result = await runInfrastructureProbe(probeName, channel, testSpec.infrastructure!);
            console.log(`    ${probeName}: ${result.status} (${result.duration_ms}ms)`);
            console.log(JSON.stringify({
              event: "test_complete", test_name: probeName, test_type: "infrastructure",
              status: result.status, duration_ms: result.duration_ms,
              error_origin: result.diagnostics?.error_origin ?? null,
              error_detail: result.diagnostics?.error_detail ?? null,
              channel: { bytes_sent: channel.stats.bytesSent, bytes_received: channel.stats.bytesReceived, errors: channel.stats.errorEvents },
            }));
            onTestComplete?.(result);
            return result;
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`    ${probeName}: error — ${errorMsg}`);
            const result: AudioTestResult = {
              test_name: probeName,
              status: "error",
              metrics: {},
              transcriptions: {},
              duration_ms: 0,
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
            onTestComplete?.(result);
            return result;
          } finally {
            await channel.disconnect().catch(() => {});
          }
        }),
      );

      infrastructureResults.push(...probeResults);
    }
  }

  // =====================================================
  // Phase 2: Layers 2-4 — Conversation tests (concurrent)
  // =====================================================
  const redTeamTests = testSpec.red_team ? expandRedTeamTests(testSpec.red_team) : [];
  const allConversationTests = [...(testSpec.conversation_tests ?? []), ...redTeamTests];

  const conversationTasks = allConversationTests.map((spec) => async () => {
    const testName = spec.name ?? `conversation:${spec.caller_prompt.slice(0, 50)}`;
    onTestStart?.({ test_name: testName, test_type: "conversation" });
    console.log(`  Conversation: ${spec.caller_prompt.slice(0, 60)}...`);
    const channel = createAudioChannel(channelConfig);
    const start = Date.now();
    try {
      await channel.connect();
      const result = await runConversationTest(spec, channel);
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
      const result: ConversationTestResult = {
        name: spec.name,
        caller_prompt: spec.caller_prompt,
        status: "fail",
        transcript: [],
        eval_results: [],
        duration_ms: Date.now() - start,
        metrics: { turns: 0, mean_ttfb_ms: 0, total_duration_ms: Date.now() - start },
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

  const conversationResults = conversationTasks.length > 0
    ? await runWithConcurrency(conversationTasks, concurrencyLimit)
    : [];

  // =====================================================
  // Aggregate results
  // =====================================================
  const infraCompleted = infrastructureResults.filter((r) => r.status === "completed").length;
  const infraErrored = infrastructureResults.filter((r) => r.status === "error").length;
  const convPassed = conversationResults.filter((r) => r.status === "pass").length;
  const convFailed = conversationResults.filter((r) => r.status === "fail").length;

  const totalDurationMs =
    infrastructureResults.reduce((sum, r) => sum + r.duration_ms, 0) +
    conversationResults.reduce((sum, r) => sum + r.duration_ms, 0);

  const aggregate: RunAggregateV2 = {
    infrastructure: { total: infrastructureResults.length, completed: infraCompleted, errored: infraErrored },
    conversation_tests: { total: conversationResults.length, passed: convPassed, failed: convFailed },
    total_duration_ms: totalDurationMs,
  };

  // Status: fail if any conversation test failed (infrastructure doesn't affect pass/fail)
  const status = convFailed === 0 ? "pass" : "fail";

  console.log(
    `Run complete: ${status} (infrastructure: ${infraCompleted}/${infrastructureResults.length}, conversation: ${convPassed}/${conversationResults.length})`,
  );

  return { status, infrastructureResults, conversationResults, aggregate };
}
