import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@vent/db";
import { RunnerCallbackV2Schema, RUNNER_CALLBACK_HEADER, FLEET_ACTIVE_RUNS_KEY } from "@vent/shared";
import { broadcast } from "../lib/run-subscribers.js";

export async function callbackRoutes(app: FastifyInstance) {
  // --- Run lifecycle event callback (from runner or worker) ---
  app.post("/internal/run-event", async (request, reply) => {
    const secret = (request.headers as Record<string, string>)[RUNNER_CALLBACK_HEADER];
    const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];

    if (!expectedSecret || secret !== expectedSecret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const body = request.body as {
      run_id: string;
      event_type: string;
      message: string;
      metadata_json?: Record<string, unknown>;
    };

    const [inserted] = await app.db
      .insert(schema.runEvents)
      .values({
        run_id: body.run_id,
        event_type: body.event_type,
        message: body.message,
        metadata_json: body.metadata_json ?? null,
      })
      .returning();

    // Push to SSE subscribers (dashboard)
    broadcast(body.run_id, {
      id: inserted!.id,
      run_id: body.run_id,
      event_type: body.event_type,
      message: body.message,
      metadata_json: body.metadata_json ?? null,
      created_at: inserted!.created_at.toISOString(),
    });

    return reply.send({ ok: true });
  });

  // --- Per-call progress callback (from runner) ---
  app.post("/internal/call-progress", async (request, reply) => {
    const secret = (request.headers as Record<string, string>)[RUNNER_CALLBACK_HEADER];
    const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];

    if (!expectedSecret || secret !== expectedSecret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const body = request.body as {
      run_id: string;
      completed: number;
      total: number;
      call_type: "conversation";
      call_name: string;
      status: "pass" | "fail" | "completed" | "error";
      duration_ms: number;
      result?: Record<string, unknown>;
    };

    // Insert partial result into DB for incremental visibility via vent_get_run_status
    if (body.result) {
      try {
        await app.db.insert(schema.scenarioResults).values({
          run_id: body.run_id,
          name: body.call_name,
          status: body.status === "pass" || body.status === "completed" ? "completed" : "error",
          test_type: body.call_type,
          metrics_json: body.result,
          trace_json: (body.result as { transcript?: unknown }).transcript ?? [],
        });
      } catch (err) {
        app.log.warn(
          { run_id: body.run_id, call_name: body.call_name, error: err instanceof Error ? err.message : String(err) },
          "Failed to insert incremental scenario result"
        );
      }
    }

    // Broadcast to SSE subscribers (dashboard)
    const progressMessage = `${body.call_name}: ${body.status} (${body.duration_ms}ms)`;
    const progressMetadata: Record<string, unknown> = {
      call_name: body.call_name,
      call_type: body.call_type,
      status: body.status,
      duration_ms: body.duration_ms,
      completed: body.completed,
      total: body.total,
    };

    // Include formatted result so CLI can show rich metrics (intent, latency)
    if (body.result) {
      progressMetadata.result = body.result;
    }

    const [progressEvent] = await app.db
      .insert(schema.runEvents)
      .values({
        run_id: body.run_id,
        event_type: "call_completed",
        message: progressMessage,
        metadata_json: progressMetadata,
      })
      .returning();

    broadcast(body.run_id, {
      id: progressEvent!.id,
      run_id: body.run_id,
      event_type: "call_completed",
      message: progressMessage,
      metadata_json: progressMetadata,
      created_at: progressEvent!.created_at.toISOString(),
    });

    return reply.send({ ok: true });
  });

  // --- Runner results callback ---
  app.post("/internal/runner-callback", async (request, reply) => {
    const secret = (request.headers as Record<string, string>)[RUNNER_CALLBACK_HEADER];
    const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];

    if (!expectedSecret || secret !== expectedSecret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const body = RunnerCallbackV2Schema.parse(request.body);

    // Release fleet capacity slot (idempotent — SREM is safe to call multiple times)
    const removed = await app.redis.srem(FLEET_ACTIVE_RUNS_KEY, body.run_id).catch(() => 0);
    const activeAfter = await app.redis.scard(FLEET_ACTIVE_RUNS_KEY).catch(() => -1);
    console.log(`[fleet-cap] SREM callback run=${body.run_id} removed=${removed} active=${activeAfter}`);

    // Atomic transaction: DELETE partials → INSERT final results → UPDATE run status.
    // Without a transaction, a long-poll can wake mid-operation and return incomplete data.
    await app.db.transaction(async (tx) => {
      // Clear any partial results inserted during call-progress — final batch is authoritative
      await tx
        .delete(schema.scenarioResults)
        .where(eq(schema.scenarioResults.run_id, body.run_id));

      // Store call result
      const result = body.conversation_result;
      await tx.insert(schema.scenarioResults).values({
        run_id: body.run_id,
        name: result.name ?? `conversation:${result.caller_prompt.slice(0, 50)}`,
        status: result.status,
        test_type: "conversation",
        metrics_json: result,
        trace_json: result.transcript,
      });

      // Update run status LAST — this is what triggers long-poll/SSE listeners to wake up
      await tx
        .update(schema.runs)
        .set({
          status: body.status,
          finished_at: new Date(),
          duration_ms: body.aggregate.total_duration_ms,
          aggregate_json: body.aggregate,
          error_text: body.error_text ?? null,
        })
        .where(eq(schema.runs.id, body.run_id));
    });

    // Broadcast run_complete to SSE subscribers (dashboard)
    const convAgg = body.aggregate.conversation_calls;
    const completeMessage = `${body.status}: ${convAgg.passed}/${convAgg.total} conversation`;
    const completeMetadata = {
      status: body.status,
      total_calls: 1,
      passed_calls: convAgg.passed,
      failed_calls: convAgg.failed,
      aggregate: body.aggregate,
    };

    const [runCompleteEvent] = await app.db
      .insert(schema.runEvents)
      .values({
        run_id: body.run_id,
        event_type: "run_complete",
        message: completeMessage,
        metadata_json: completeMetadata,
      })
      .returning();

    broadcast(body.run_id, {
      id: runCompleteEvent!.id,
      run_id: body.run_id,
      event_type: "run_complete",
      message: completeMessage,
      metadata_json: completeMetadata,
      created_at: runCompleteEvent!.created_at.toISOString(),
    });

    return reply.send({ ok: true });
  });
}
