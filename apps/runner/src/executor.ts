/**
 * Extracted test execution logic — can be called from the Fly Machine entrypoint
 * OR directly from the API process (for already-deployed agents).
 *
 * All tests run in parallel with a concurrency limiter.
 * Each test creates its own AudioChannel for isolation.
 */

import type {
  TestSpec,
  AudioTestResult,
  ConversationTestResult,
  RunAggregateV2,
  AudioTestThresholds,
} from "@voiceci/shared";
import { createAudioChannel, type AudioChannelConfig } from "@voiceci/adapters";
import { runAudioTest } from "./audio-tests/index.js";
import { runConversationTest } from "./conversation/index.js";

export interface TestStartInfo {
  test_name: string;
  test_type: "audio" | "conversation";
}

export interface ExecuteTestsOpts {
  testSpec: TestSpec;
  channelConfig: AudioChannelConfig;
  audioTestThresholds?: AudioTestThresholds;
  concurrencyLimit?: number;
  onTestStart?: (info: TestStartInfo) => void;
  onTestComplete?: (result: AudioTestResult | ConversationTestResult) => void;
}

export interface ExecuteTestsResult {
  status: "pass" | "fail";
  audioResults: AudioTestResult[];
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

export async function executeTests(opts: ExecuteTestsOpts): Promise<ExecuteTestsResult> {
  const {
    testSpec,
    channelConfig,
    audioTestThresholds,
    concurrencyLimit = ["sip", "retell", "bland"].includes(channelConfig.adapter) ? 5 : 10,
    onTestStart,
    onTestComplete,
  } = opts;

  const audioTasks = (testSpec.audio_tests ?? []).map((testName) => async () => {
    onTestStart?.({ test_name: testName, test_type: "audio" });
    console.log(`  Audio test: ${testName}`);
    const channel = createAudioChannel(channelConfig);
    try {
      await channel.connect();
      const result = await runAudioTest(testName, channel, audioTestThresholds);
      console.log(`    ${testName}: ${result.status} (${result.duration_ms}ms)`);
      onTestComplete?.(result);
      return result;
    } finally {
      await channel.disconnect().catch(() => {});
    }
  });

  const conversationTasks = (testSpec.conversation_tests ?? []).map((spec) => async () => {
    const testName = spec.name ?? `conversation:${spec.caller_prompt.slice(0, 50)}`;
    onTestStart?.({ test_name: testName, test_type: "conversation" });
    console.log(`  Conversation: ${spec.caller_prompt.slice(0, 60)}...`);
    const channel = createAudioChannel(channelConfig);
    const start = Date.now();
    try {
      await channel.connect();
      const result = await runConversationTest(spec, channel);
      console.log(`    Status: ${result.status} (${result.duration_ms}ms)`);
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
      };
      onTestComplete?.(result);
      return result;
    } finally {
      await channel.disconnect().catch(() => {});
    }
  });

  const totalTests = audioTasks.length + conversationTasks.length;
  console.log(`Running ${totalTests} tests in parallel (concurrency: ${concurrencyLimit})...`);

  // Merge into a single pool so the concurrency limit is truly shared
  type TaggedResult =
    | { type: "audio"; result: AudioTestResult }
    | { type: "conversation"; result: ConversationTestResult };

  const allTasks: (() => Promise<TaggedResult>)[] = [
    ...audioTasks.map((task) => async (): Promise<TaggedResult> => ({ type: "audio", result: await task() })),
    ...conversationTasks.map((task) => async (): Promise<TaggedResult> => ({ type: "conversation", result: await task() })),
  ];

  const allResults = await runWithConcurrency(allTasks, concurrencyLimit);

  const audioResults = allResults
    .filter((r): r is Extract<TaggedResult, { type: "audio" }> => r.type === "audio")
    .map((r) => r.result);
  const conversationResults = allResults
    .filter((r): r is Extract<TaggedResult, { type: "conversation" }> => r.type === "conversation")
    .map((r) => r.result);

  const audioPassed = audioResults.filter((r) => r.status === "pass").length;
  const audioFailed = audioResults.filter((r) => r.status === "fail").length;
  const convPassed = conversationResults.filter((r) => r.status === "pass").length;
  const convFailed = conversationResults.filter((r) => r.status === "fail").length;

  const totalDurationMs =
    audioResults.reduce((sum, r) => sum + r.duration_ms, 0) +
    conversationResults.reduce((sum, r) => sum + r.duration_ms, 0);

  const aggregate: RunAggregateV2 = {
    audio_tests: { total: audioResults.length, passed: audioPassed, failed: audioFailed },
    conversation_tests: { total: conversationResults.length, passed: convPassed, failed: convFailed },
    total_duration_ms: totalDurationMs,
  };

  const status = audioFailed + convFailed === 0 ? "pass" : "fail";

  console.log(
    `Run complete: ${status} (audio: ${audioPassed}/${audioResults.length}, conversation: ${convPassed}/${conversationResults.length})`,
  );

  return { status, audioResults, conversationResults, aggregate };
}
