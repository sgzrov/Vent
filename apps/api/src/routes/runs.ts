import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { schema } from "@vent/db";
import { broadcast } from "../lib/run-subscribers.js";
import { RunSubmitSchema, submitRun, SubmitRunConfigError, UsageLimitError, FleetCapacityError } from "../lib/run-submit.js";
import { FLEET_ACTIVE_RUNS_KEY } from "@vent/shared";

export async function runRoutes(app: FastifyInstance) {
  const accessTokenPreHandler = { preHandler: app.verifyAccessToken };

  // --- Submit a run with full call config (used by CLI) ---
  app.post("/runs/submit", accessTokenPreHandler, async (request, reply) => {
    const parsed = RunSubmitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid config",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    let result;
    try {
      result = await submitRun(app, {
        accessTokenId: request.accessTokenId!,
        userId: request.userId!,
        config: parsed.data.config,
        idempotencyKey: parsed.data.idempotency_key,
        agentSessionId: parsed.data.agent_session_id,
      });
    } catch (err) {
      if (err instanceof FleetCapacityError) {
        return reply.status(429).send({
          error: err.message,
          code: "FLEET_CAPACITY",
          retry_after: 10,
        });
      }
      if (err instanceof UsageLimitError) {
        return reply.status(403).send({
          error: err.message,
          code: "USAGE_LIMIT",
          limit: err.limit,
          used: err.used,
        });
      }
      if (err instanceof SubmitRunConfigError) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      throw err;
    }

    return reply.status(201).send(result);
  });

  // --- Stream run events (SSE) ---
  app.get<{ Params: { id: string } }>("/runs/:id/stream", accessTokenPreHandler, async (request, reply) => {
    const { id } = request.params;

    const [run] = await app.db
      .select({ id: schema.runs.id, status: schema.runs.status })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, id), eq(schema.runs.user_id, request.userId!)))
      .limit(1);

    if (!run) return reply.status(404).send({ error: "Run not found" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const write = (event: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay historical events from DB
    const history = await app.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.run_id, id))
      .orderBy(schema.runEvents.created_at);

    let alreadyComplete = false;
    for (const evt of history) {
      write({
        id: evt.id,
        run_id: evt.run_id,
        event_type: evt.event_type,
        message: evt.message,
        metadata_json: evt.metadata_json,
        created_at: evt.created_at.toISOString(),
      });
      if (evt.event_type === "run_complete" || evt.event_type === "run_cancelled") {
        alreadyComplete = true;
      }
    }

    if (alreadyComplete || ["pass", "fail", "cancelled"].includes(run.status)) {
      reply.raw.end();
      return;
    }

    // Subscribe to live events via Redis pub/sub
    const sub = app.redis.duplicate();
    const channel = `vent:run-events:${id}`;
    await sub.subscribe(channel);

    sub.on("message", (_ch: string, message: string) => {
      try {
        const event = JSON.parse(message);
        write(event);
        if (event.event_type === "run_complete" || event.event_type === "run_cancelled") {
          sub.unsubscribe(channel);
          sub.disconnect();
          reply.raw.end();
        }
      } catch { /* ignore malformed */ }
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 30_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      sub.unsubscribe(channel).catch(() => {});
      sub.disconnect();
    });
  });

  // --- Get run status (JSON) ---
  app.get<{ Params: { id: string } }>("/runs/:id", accessTokenPreHandler, async (request, reply) => {
    const [run] = await app.db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.id, request.params.id), eq(schema.runs.user_id, request.userId!)))
      .limit(1);

    if (!run) return reply.status(404).send({ error: "Run not found" });

    const results = await app.db
      .select()
      .from(schema.scenarioResults)
      .where(eq(schema.scenarioResults.run_id, run.id));

    return reply.send({
      id: run.id,
      status: run.status,
      created_at: run.created_at,
      started_at: run.started_at,
      finished_at: run.finished_at,
      duration_ms: run.duration_ms,
      error_text: run.error_text,
      aggregate: run.aggregate_json,
      results: results.map((r) => r.metrics_json),
    });
  });

  // --- Stop/cancel a run ---
  app.post<{ Params: { id: string } }>(
    "/runs/:id/stop",
    accessTokenPreHandler,
    async (request, reply) => {
      const { id } = request.params;

      const [run] = await app.db
        .select()
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.id, id),
            eq(schema.runs.user_id, request.userId!),
          )
        )
        .limit(1);

      if (!run) {
        return reply.status(404).send({ error: "Run not found" });
      }

      if (run.status === "pass" || run.status === "fail" || run.status === "cancelled") {
        return reply.status(409).send({
          error: `Run already ${run.status}`,
          status: run.status,
        });
      }

      const now = new Date();

      if (run.status === "queued") {
        // Try to remove from BullMQ before it gets picked up
        try {
          const job = await app.getRunQueue(request.userId!).getJob(id);
          if (job) await job.remove();
        } catch {
          // Job may already be processing — that's fine
        }
      }

      // Signal worker to skip the run if it was just picked up but has not
      // started execution yet. This closes the race where BullMQ has the job
      // active but the DB row still looks queued.
      await app.redis.set(`vent:cancelled:${id}`, "1", "EX", 600);

      // Release fleet capacity slot (idempotent)
      const removed = await app.redis.srem(FLEET_ACTIVE_RUNS_KEY, id).catch(() => 0);
      const activeAfter = await app.redis.scard(FLEET_ACTIVE_RUNS_KEY).catch(() => -1);
      console.log(`[fleet-cap] SREM cancel run=${id} removed=${removed} active=${activeAfter}`);

      // Update DB status
      await app.db
        .update(schema.runs)
        .set({
          status: "cancelled",
          finished_at: now,
          error_text: "Cancelled by user",
        })
        .where(eq(schema.runs.id, id));

      // Emit cancellation event for SSE subscribers
      const event = {
        run_id: id,
        event_type: "run_cancelled",
        message: "Run cancelled by user",
      };

      await app.db.insert(schema.runEvents).values(event);
      broadcast(id, event);

      return reply.send({ id, status: "cancelled" });
    }
  );
}
