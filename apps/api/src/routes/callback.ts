import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@vent/db";
import {
  RunnerCallbackV2Schema,
  RunEventCallbackSchema,
  CallProgressCallbackSchema,
  RUNNER_CALLBACK_SIGNATURE_HEADER,
  RUNNER_CALLBACK_TIMESTAMP_HEADER,
  FLEET_ACTIVE_RUNS_KEY,
  verifyCallback,
} from "@vent/shared";
import { broadcast } from "../lib/run-subscribers.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

function authorize(request: FastifyRequest, reply: FastifyReply): boolean {
  const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];
  if (!expectedSecret) {
    reply.status(500).send({ error: "Callback secret not configured" });
    return false;
  }

  const sig = request.headers[RUNNER_CALLBACK_SIGNATURE_HEADER];
  const ts = request.headers[RUNNER_CALLBACK_TIMESTAMP_HEADER];
  const sigStr = Array.isArray(sig) ? sig[0] : sig;
  const tsStr = Array.isArray(ts) ? ts[0] : ts;
  const rawBody = request.rawBody ?? "";

  const result = verifyCallback(rawBody, expectedSecret, sigStr, tsStr);
  if (!result.ok) {
    request.log.warn({ reason: result.reason, route: request.url }, "callback auth rejected");
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export async function callbackRoutes(app: FastifyInstance) {
  // Internal callback routes can carry full conversation transcripts which
  // routinely exceed the global 1MB default.
  const INTERNAL_BODY_LIMIT = 10 * 1024 * 1024;

  // --- Run lifecycle event callback (from runner or worker) ---
  app.post("/internal/run-event", { bodyLimit: INTERNAL_BODY_LIMIT }, async (request, reply) => {
    if (!authorize(request, reply)) return;

    const parsed = RunEventCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.format() });
    }
    const body = parsed.data;

    const [inserted] = await app.db
      .insert(schema.runEvents)
      .values({
        run_id: body.run_id,
        event_type: body.event_type,
        message: body.message,
        metadata_json: body.metadata_json ?? null,
      })
      .returning();

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
  app.post("/internal/call-progress", { bodyLimit: INTERNAL_BODY_LIMIT }, async (request, reply) => {
    if (!authorize(request, reply)) return;

    const parsed = CallProgressCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.format() });
    }
    const body = parsed.data;

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
          "Failed to insert incremental scenario result",
        );
      }
    }

    const progressMessage = `${body.call_name}: ${body.status} (${body.duration_ms}ms)`;
    const progressMetadata: Record<string, unknown> = {
      call_name: body.call_name,
      call_type: body.call_type,
      status: body.status,
      duration_ms: body.duration_ms,
      completed: body.completed,
      total: body.total,
    };
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
  app.post("/internal/runner-callback", { bodyLimit: INTERNAL_BODY_LIMIT }, async (request, reply) => {
    if (!authorize(request, reply)) return;

    const parsed = RunnerCallbackV2Schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.format() });
    }
    const body = parsed.data;

    // Idempotency guard: postSignedWithRetry on the worker side may resend
    // the same callback if the first response was lost. Without this guard,
    // the second arrival would DELETE+INSERT scenario_results again and,
    // worse, INSERT a duplicate `run_complete` row in run_events (no unique
    // constraint there, so the SSE consumer sees two run_complete events).
    // SETNX with EX is atomic — first arrival wins; subsequent ones return
    // 200 OK without doing any DB work, satisfying the worker's "got 2xx"
    // termination condition.
    const idempotencyKey = `vent:callback-done:${body.run_id}`;
    const claimed = await app.redis.set(idempotencyKey, "1", "EX", 3600, "NX");
    if (claimed === null) {
      request.log.info({ run_id: body.run_id }, "runner-callback duplicate (idempotency hit)");
      return reply.send({ ok: true, deduplicated: true });
    }

    const removed = await app.redis.srem(FLEET_ACTIVE_RUNS_KEY, body.run_id).catch(() => 0);
    const activeAfter = await app.redis.scard(FLEET_ACTIVE_RUNS_KEY).catch(() => -1);
    console.log(`[fleet-cap] SREM callback run=${body.run_id} removed=${removed} active=${activeAfter}`);

    await app.db.transaction(async (tx) => {
      await tx
        .delete(schema.scenarioResults)
        .where(eq(schema.scenarioResults.run_id, body.run_id));

      const result = body.conversation_result;
      await tx.insert(schema.scenarioResults).values({
        run_id: body.run_id,
        name: result.name ?? `conversation:${result.caller_prompt.slice(0, 50)}`,
        status: result.status,
        test_type: "conversation",
        metrics_json: result,
        trace_json: result.transcript,
      });

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
