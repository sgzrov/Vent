import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@voiceci/db";
import { RunnerCallbackV2Schema, RUNNER_CALLBACK_HEADER } from "@voiceci/shared";
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

  // --- Per-test progress callback (from runner) ---
  app.post("/internal/test-progress", async (request, reply) => {
    const secret = (request.headers as Record<string, string>)[RUNNER_CALLBACK_HEADER];
    const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];

    if (!expectedSecret || secret !== expectedSecret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const body = request.body as {
      run_id: string;
      completed: number;
      total: number;
      test_type: "audio" | "conversation";
      test_name: string;
      status: "pass" | "fail";
      duration_ms: number;
      result?: Record<string, unknown>;
    };

    // Insert partial result into DB for incremental visibility via voiceci_get_run_status
    if (body.result) {
      try {
        const isConversation = body.test_type === "conversation";
        await app.db.insert(schema.scenarioResults).values({
          run_id: body.run_id,
          name: body.test_name,
          status: body.status,
          test_type: body.test_type,
          metrics_json: body.result,
          trace_json: isConversation
            ? (body.result as { transcript?: unknown }).transcript ?? []
            : [],
        });
      } catch (err) {
        app.log.warn(
          { run_id: body.run_id, test_name: body.test_name, error: err instanceof Error ? err.message : String(err) },
          "Failed to insert incremental scenario result"
        );
      }
    }

    // Broadcast to SSE subscribers (dashboard)
    broadcast(body.run_id, {
      run_id: body.run_id,
      event_type: "test_completed",
      message: `${body.test_name}: ${body.status} (${body.duration_ms}ms)`,
      metadata_json: {
        test_name: body.test_name,
        test_type: body.test_type,
        status: body.status,
        duration_ms: body.duration_ms,
        completed: body.completed,
        total: body.total,
      },
      created_at: new Date().toISOString(),
    });

    return reply.send({ ok: true });
  });

  // --- Run activation (called by relay client for local agents) ---
  // Config is always pre-stored by voiceci_run_tests — this activates the run and queues the job.
  app.post<{ Params: { id: string } }>("/internal/runs/:id/activate", async (request, reply) => {
    const runId = request.params.id;
    const body = request.body as Record<string, unknown>;

    const [run] = await app.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);

    if (!run) {
      return reply.status(404).send({ error: "Run not found" });
    }

    if (run.status !== "queued") {
      return reply.status(409).send({ error: "Run already activated" });
    }

    if (!run.test_spec_json) {
      return reply.status(400).send({ error: "Run has no stored config — voiceci_run_tests must be called first" });
    }

    // Authenticate via relay token
    const relayToken = body.relay_token as string | undefined;
    if (!relayToken || relayToken !== run.relay_token) {
      return reply.status(401).send({ error: "Invalid relay token" });
    }

    const spec = run.test_spec_json as Record<string, unknown>;

    await app.getRunQueue(run.user_id).add("execute-run", {
      run_id: runId,
      bundle_key: null,
      bundle_hash: null,
      lockfile_hash: null,
      adapter: spec.adapter as string,
      test_spec: {
        audio_tests: spec.audio_tests ?? null,
        conversation_tests: spec.conversation_tests ?? null,
        red_team: spec.red_team ?? null,
      },
      target_phone_number: spec.target_phone_number as string | undefined,
      voice_config: spec.voice_config ?? { adapter: spec.adapter },
      audio_test_thresholds: spec.audio_test_thresholds ?? null,
      start_command: spec.start_command as string | undefined,
      health_endpoint: spec.health_endpoint as string | undefined,
      agent_url: spec.agent_url as string | undefined,
      platform: spec.platform ?? null,
      relay: true,
    });

    return reply.send({ status: "queued", run_id: runId });
  });

  // --- Relay run complete notification (from worker to signal relay cleanup) ---
  app.post("/internal/relay-complete", async (request, reply) => {
    const secret = (request.headers as Record<string, string>)[RUNNER_CALLBACK_HEADER];
    const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];

    if (!expectedSecret || secret !== expectedSecret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const body = request.body as { run_id: string };

    // Import and call notifyRunComplete to clean up relay session
    const { notifyRunComplete } = await import("./relay.js");
    notifyRunComplete(body.run_id);

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

    await app.db
      .update(schema.runs)
      .set({
        status: body.status,
        finished_at: new Date(),
        duration_ms: body.aggregate.total_duration_ms,
        aggregate_json: body.aggregate,
        error_text: body.error_text ?? null,
      })
      .where(eq(schema.runs.id, body.run_id));

    // Clear any partial results inserted during test-progress — final batch is authoritative
    await app.db
      .delete(schema.scenarioResults)
      .where(eq(schema.scenarioResults.run_id, body.run_id));

    // Store audio test results
    for (const result of body.audio_results) {
      await app.db.insert(schema.scenarioResults).values({
        run_id: body.run_id,
        name: result.test_name,
        status: result.status,
        test_type: "audio",
        metrics_json: result,
        trace_json: [],
      });
    }

    // Store conversation test results
    for (const result of body.conversation_results) {
      await app.db.insert(schema.scenarioResults).values({
        run_id: body.run_id,
        name: result.name ?? `conversation:${result.caller_prompt.slice(0, 50)}`,
        status: result.status,
        test_type: "conversation",
        metrics_json: result,
        trace_json: result.transcript,
      });
    }

    // Broadcast run_complete to SSE subscribers (dashboard)
    const totalTests = body.audio_results.length + body.conversation_results.length;
    broadcast(body.run_id, {
      run_id: body.run_id,
      event_type: "run_complete",
      message: `${body.status}: ${body.aggregate.audio_tests.passed}/${body.aggregate.audio_tests.total} audio, ${body.aggregate.conversation_tests.passed}/${body.aggregate.conversation_tests.total} conversation`,
      metadata_json: {
        status: body.status,
        total_tests: totalTests,
        aggregate: body.aggregate,
      },
      created_at: new Date().toISOString(),
    });

    return reply.send({ ok: true });
  });
}
