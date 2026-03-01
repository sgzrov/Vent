/**
 * In-process runners for lightweight operations that don't need queueing.
 * Test suite execution has moved to the worker via BullMQ per-user queues.
 */

import type { AudioChannelConfig } from "@voiceci/adapters";
import type { LoadPattern } from "@voiceci/shared";
import { runLoadTest } from "@voiceci/runner/load-test";

// ============================================================
// Load testing
// ============================================================

const activeLoadTests = new Set<Promise<void>>();

export interface LoadTestInProcessOpts {
  channelConfig: AudioChannelConfig;
  pattern: LoadPattern;
  targetConcurrency: number;
  totalDurationS: number;
  rampDurationS?: number;
  callerPrompt: string;
}

/**
 * Run load test in-process.
 * Non-blocking — fires and returns immediately.
 */
export function runLoadTestInProcess(opts: LoadTestInProcessOpts): void {
  const promise = (async () => {
    try {
      await runLoadTest(opts);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error("Load test failed:", errorMessage);
    }
  })();

  activeLoadTests.add(promise);
  void promise.finally(() => activeLoadTests.delete(promise));
}

/**
 * Wait for all active load tests to finish. Call during graceful shutdown.
 */
export async function drainLoadTests(): Promise<void> {
  if (activeLoadTests.size > 0) {
    console.log(`Waiting for ${activeLoadTests.size} active load test(s) to finish...`);
    await Promise.allSettled(activeLoadTests);
  }
}
