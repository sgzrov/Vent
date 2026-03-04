/**
 * In-process runners for lightweight operations that don't need queueing.
 * Test suite execution has moved to the worker via BullMQ per-user queues.
 */

import type { FastifyInstance } from "fastify";
import type { AudioChannelConfig } from "@voiceci/adapters";
import type { LoadPattern, LoadTestTimepoint, RunAggregateV2 } from "@voiceci/shared";
import { runLoadTest } from "@voiceci/runner/load-test";
import { schema } from "@voiceci/db";
import { eq } from "drizzle-orm";
import { broadcast } from "../lib/run-subscribers.js";

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
 * Run load test in-process with full persistence.
 * Creates a run record, fires the test in the background, and returns the run ID immediately.
 * Results are persisted when the test completes and streamed via SSE + long-poll.
 */
export async function runLoadTestInProcess(
  opts: LoadTestInProcessOpts,
  app: FastifyInstance,
  apiKeyId: string,
  userId: string,
): Promise<string> {
  // Create the run record
  const [run] = await app.db
    .insert(schema.runs)
    .values({
      api_key_id: apiKeyId,
      user_id: userId,
      source_type: "remote",
      status: "running",
      started_at: new Date(),
      test_spec_json: {
        load_test: {
          pattern: opts.pattern,
          target_concurrency: opts.targetConcurrency,
          total_duration_s: opts.totalDurationS,
          ramp_duration_s: opts.rampDurationS,
          caller_prompt: opts.callerPrompt,
        },
      },
    })
    .returning();

  const runId = run!.id;

  // Broadcast run_started event
  await app.db.insert(schema.runEvents).values({
    run_id: runId,
    event_type: "run_started",
    message: `Load test started: ${opts.pattern} pattern, target ${opts.targetConcurrency} concurrent`,
    metadata_json: { pattern: opts.pattern, target_concurrency: opts.targetConcurrency },
  });

  broadcast(runId, {
    run_id: runId,
    event_type: "run_started",
    message: `Load test started: ${opts.pattern} pattern, target ${opts.targetConcurrency} concurrent`,
    metadata_json: { pattern: opts.pattern, target_concurrency: opts.targetConcurrency },
  });

  // Execute load test in background — non-blocking
  const promise = (async () => {
    try {
      const result = await runLoadTest({
        ...opts,
        onTimepoint: (tp: LoadTestTimepoint) => {
          // Broadcast via SSE for live dashboard clients
          broadcast(runId, {
            run_id: runId,
            event_type: "load_test_timepoint",
            message: `t=${tp.elapsed_s}s: ${tp.active_connections} connections, p95=${Math.round(tp.ttfb_p95_ms)}ms, err=${(tp.error_rate * 100).toFixed(1)}%`,
            metadata_json: tp as unknown as Record<string, unknown>,
          });
        },
      });

      // Persist final result
      const aggregate: RunAggregateV2 = {
        infrastructure: { total: 0, completed: 0, errored: 0 },
        conversation_tests: { total: 0, passed: 0, failed: 0 },
        load_tests: {
          total: 1,
          passed: result.status === "pass" ? 1 : 0,
          failed: result.status === "fail" ? 1 : 0,
        },
        total_duration_ms: result.duration_ms,
      };

      await app.db
        .update(schema.runs)
        .set({
          status: result.status,
          finished_at: new Date(),
          duration_ms: result.duration_ms,
          aggregate_json: aggregate,
        })
        .where(eq(schema.runs.id, runId));

      await app.db.insert(schema.scenarioResults).values({
        run_id: runId,
        name: `load-test:${result.pattern}`,
        status: result.status,
        test_type: "load_test",
        metrics_json: result,
        trace_json: result.timeline,
      });

      // Broadcast completion
      const completeMessage = `${result.status}: ${result.total_calls} calls, ${result.successful_calls} success, ${result.failed_calls} failed`;
      await app.db.insert(schema.runEvents).values({
        run_id: runId,
        event_type: "run_complete",
        message: completeMessage,
        metadata_json: { status: result.status, aggregate },
      });

      broadcast(runId, {
        run_id: runId,
        event_type: "run_complete",
        message: completeMessage,
        metadata_json: { status: result.status, aggregate },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error("Load test failed:", errorMessage);

      await app.db
        .update(schema.runs)
        .set({
          status: "fail",
          finished_at: new Date(),
          error_text: errorMessage,
        })
        .where(eq(schema.runs.id, runId));

      await app.db.insert(schema.runEvents).values({
        run_id: runId,
        event_type: "run_complete",
        message: `Load test error: ${errorMessage}`,
        metadata_json: { status: "fail", error: errorMessage },
      });

      broadcast(runId, {
        run_id: runId,
        event_type: "run_complete",
        message: `Load test error: ${errorMessage}`,
        metadata_json: { status: "fail", error: errorMessage },
      });
    }
  })();

  activeLoadTests.add(promise);
  void promise.finally(() => activeLoadTests.delete(promise));

  return runId;
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
