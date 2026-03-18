import type { FastifyInstance } from "fastify";
import { eq, and, desc, asc } from "drizzle-orm";
import { schema } from "@vent/db";
import { subscribe, unsubscribe } from "../lib/run-subscribers.js";
import { RunSubmitSchema, submitRun } from "../lib/run-submit.js";

export async function runRoutes(app: FastifyInstance) {
  const authPreHandler = { preHandler: app.verifyAuth };
  const apiKeyPreHandler = { preHandler: app.verifyApiKey };

  // --- Submit a run with full test config (used by CLI) ---
  app.post("/runs/submit", apiKeyPreHandler, async (request, reply) => {
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

    const result = await submitRun(app, {
      apiKeyId: request.apiKeyId!,
      userId: request.userId!,
      config: parsed.data.config,
      idempotencyKey: parsed.data.idempotency_key,
    });

    return reply.status(201).send(result);
  });

  app.get("/runs", authPreHandler, async (request, reply) => {
    const query = request.query as { status?: string; limit?: string };
    const limit = Math.min(parseInt(query.limit ?? "50", 10), 200);

    const conditions = [eq(schema.runs.user_id, request.userId!)];
    if (query.status) {
      conditions.push(
        eq(schema.runs.status, query.status as "queued" | "running" | "pass" | "fail"),
      );
    }

    const rows = await app.db
      .select()
      .from(schema.runs)
      .where(and(...conditions))
      .orderBy(desc(schema.runs.created_at))
      .limit(limit);

    return reply.send(rows);
  });

  app.get<{ Params: { id: string } }>("/runs/:id", authPreHandler, async (request, reply) => {
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

    const scenarios = await app.db
      .select()
      .from(schema.scenarioResults)
      .where(eq(schema.scenarioResults.run_id, id));

    const artifactRows = await app.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.run_id, id));

    const events = await app.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.run_id, id))
      .orderBy(asc(schema.runEvents.created_at));

    const [baseline] = await app.db
      .select()
      .from(schema.baselines)
      .where(eq(schema.baselines.run_id, id))
      .limit(1);

    return reply.send({
      ...run,
      scenarios,
      artifacts: artifactRows,
      events,
      is_baseline: !!baseline,
    });
  });

  // --- SSE stream for live run events ---
  app.get<{ Params: { id: string } }>("/runs/:id/stream", authPreHandler, async (request, reply) => {
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

    // Take full control of the response — without hijack(), Fastify
    // serializes the handler's return value ("undefined") to the stream
    // and calls reply.raw.end(), killing the long-lived SSE connection.
    reply.hijack();

    // Set SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send existing events as initial batch
    const existingEvents = await app.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.run_id, id))
      .orderBy(asc(schema.runEvents.created_at));

    for (const event of existingEvents) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // If run is already complete, close immediately
    if (run.status === "pass" || run.status === "fail") {
      reply.raw.end();
      return;
    }

    // Subscribe for new events
    subscribe(id, reply);

    // Clean up on disconnect
    request.raw.on("close", () => {
      unsubscribe(id, reply);
    });

    // Keep connection alive with periodic heartbeat
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
    });
  });

  app.post<{ Params: { id: string } }>(
    "/runs/:id/baseline",
    authPreHandler,
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

      const [baseline] = await app.db
        .insert(schema.baselines)
        .values({ run_id: id, user_id: request.userId! })
        .returning();

      return reply.status(201).send(baseline);
    }
  );
}
