import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { schema } from "@vent/db";
import { broadcast } from "../lib/run-subscribers.js";
import { RunSubmitSchema, submitRun, SubmitRunConfigError, UsageLimitError } from "../lib/run-submit.js";

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

      if (run.status === "running") {
        // Signal worker to abort via Redis key (worker polls this)
        await app.redis.set(`vent:cancelled:${id}`, "1", "EX", 600);
      }

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
