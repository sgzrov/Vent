import type { FastifyInstance } from "fastify";
import { eq, and, inArray } from "drizzle-orm";
import { schema } from "@vent/db";
import { broadcast, subscribeToRun } from "../lib/run-subscribers.js";
import { RunSubmitSchema, submitRun, SubmitRunConfigError, FleetCapacityError } from "../lib/run-submit.js";
import { FLEET_ACTIVE_RUNS_KEY } from "@vent/shared";

export async function runRoutes(app: FastifyInstance) {
  const accessTokenPreHandler = { preHandler: app.verifyAccessToken };

  // --- Submit a run with full call config (used by CLI) ---
  app.post("/runs/submit", {
    ...accessTokenPreHandler,
    // 60 submits/minute per user is plenty for legitimate iteration; caps a
    // misbehaving CLI loop before it floods BullMQ + the worker.
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request, reply) => {
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
      // Tell nginx/Fly proxies not to buffer SSE — without this, first chunks
      // can be held back up to 8KB before the client sees anything.
      "X-Accel-Buffering": "no",
    });

    const write = (event: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Subscribe FIRST, then replay history. Without this ordering, an event
    // published between the history SELECT and subscribe is lost — the
    // runner-callback for short-lived runs frequently lands in that window,
    // leaving the CLI hanging forever. We buffer live events arriving during
    // history replay and drain them afterwards, deduplicating by event id.
    // The shared subscriber (run-subscribers.ts) is one IORedis connection
    // across all SSE clients on this instance — previously we opened one
    // connection per client, which exhausted Upstash limits under load.
    const seenIds = new Set<string | number>();
    const bufferedDuringHistory: Record<string, unknown>[] = [];
    let historyReplayed = false;
    let streamEnded = false;
    let unsubscribe: (() => void) | null = null;

    const finish = () => {
      if (streamEnded) return;
      streamEnded = true;
      unsubscribe?.();
      reply.raw.end();
    };

    const handleEvent = (event: Record<string, unknown>) => {
      // Hard guard: once finish() has been called the underlying stream is
      // ended. Any further write() throws "write after end". Drain loops
      // and live handlers can both invoke handleEvent so check here too.
      if (streamEnded) return;
      const eid =
        typeof event.id === "number" || typeof event.id === "string"
          ? event.id
          : null;
      if (eid != null) {
        if (seenIds.has(eid)) return;
        seenIds.add(eid);
      }
      write(event);
      if (event.event_type === "run_complete" || event.event_type === "run_cancelled") {
        finish();
      }
    };

    unsubscribe = await subscribeToRun(id, (message) => {
      try {
        const event = JSON.parse(message) as Record<string, unknown>;
        if (!historyReplayed) {
          bufferedDuringHistory.push(event);
        } else {
          handleEvent(event);
        }
      } catch { /* ignore malformed */ }
    });

    // Replay historical events from DB
    const history = await app.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.run_id, id))
      .orderBy(schema.runEvents.created_at);

    let historyTerminal = false;
    for (const evt of history) {
      seenIds.add(evt.id);
      write({
        id: evt.id,
        run_id: evt.run_id,
        event_type: evt.event_type,
        message: evt.message,
        metadata_json: evt.metadata_json,
        created_at: evt.created_at.toISOString(),
      });
      if (evt.event_type === "run_complete" || evt.event_type === "run_cancelled") {
        historyTerminal = true;
      }
    }

    // History is replayed. Drain anything that arrived in the gap (deduped
    // by id), then switch to live-mode. handleEvent is reentrancy-safe:
    // a terminal buffered event triggers finish() and subsequent calls
    // become no-ops via the streamEnded guard.
    for (const buffered of bufferedDuringHistory) {
      if (streamEnded) break;
      handleEvent(buffered);
    }
    bufferedDuringHistory.length = 0;
    historyReplayed = true;

    // If finish() already ran (terminal event in history or buffered drain),
    // skip heartbeat / close-listener setup entirely — they would otherwise
    // arm a 30s interval against an ended stream.
    if (streamEnded) return;

    // If history already contains a terminal event (or the run is terminal
    // in DB and never emitted a terminal event — shouldn't happen but defends
    // against pre-event-system runs), close immediately.
    if (historyTerminal || ["pass", "fail", "cancelled"].includes(run.status)) {
      const [latest] = await app.db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, id))
        .limit(1);
      if (latest && ["pass", "fail", "cancelled"].includes(latest.status)) {
        finish();
        return;
      }
    }

    const heartbeat = setInterval(() => {
      // Defensive: if the stream has been closed since this interval armed,
      // a write throws "write after end". Stop the interval first.
      if (streamEnded) {
        clearInterval(heartbeat);
        return;
      }
      reply.raw.write(": heartbeat\n\n");
    }, 30_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      finish();
    });
  });

  // ----- helper used below -----

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

      // Update DB status — guard on prior state. Without this, a concurrent
      // runner-callback that flipped the run to pass/fail would be silently
      // overwritten back to cancelled, and the dashboard would show the
      // wrong terminal state. UPDATE returns the rows it actually changed
      // so we can detect the race and respond honestly.
      const updated = await app.db
        .update(schema.runs)
        .set({
          status: "cancelled",
          finished_at: now,
          error_text: "Cancelled by user",
        })
        .where(
          and(
            eq(schema.runs.id, id),
            inArray(schema.runs.status, ["queued", "running"]),
          ),
        )
        .returning({ id: schema.runs.id });

      if (updated.length === 0) {
        // Run terminated between our SELECT and UPDATE (callback won the
        // race). Re-read the actual current status and report honestly.
        const [current] = await app.db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.id, id))
          .limit(1);
        return reply.status(409).send({
          error: `Run completed before cancel could be applied`,
          status: current?.status ?? "unknown",
        });
      }

      // Emit cancellation event for SSE subscribers — only if we actually
      // applied the cancel. Otherwise the dashboard would see a phantom
      // "cancelled" event for a run that finished successfully. Capture
      // the inserted row's id and include it in the broadcast so SSE
      // clients can dedupe between the history replay and the live event.
      const [inserted] = await app.db
        .insert(schema.runEvents)
        .values({
          run_id: id,
          event_type: "run_cancelled",
          message: "Run cancelled by user",
        })
        .returning();

      broadcast(id, {
        id: inserted!.id,
        run_id: id,
        event_type: "run_cancelled",
        message: "Run cancelled by user",
        created_at: inserted!.created_at.toISOString(),
      });

      return reply.send({ id, status: "cancelled" });
    }
  );
}
