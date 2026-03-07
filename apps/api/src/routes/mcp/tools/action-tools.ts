import type { FastifyInstance } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID, createHash } from "node:crypto";
import { eq, and, desc, asc } from "drizzle-orm";
import { schema } from "@voiceci/db";
import { z } from "zod";
import {
  AdapterTypeSchema,
  LoadTestThresholdsSchema,
  CallerAudioPoolSchema,
  ConversationTestSpecSchema,
  RedTeamAttackSchema,
  PlatformConfigSchema,
  CallerAudioEffectsSchema,
  type RedTeamAttack,
} from "@voiceci/shared";
import { expandRedTeamTests } from "@voiceci/runner/executor";
import { runLoadTestInProcess } from "../../../services/test-runner.js";
import { buildFixPlan } from "./fix-plan.js";
import { formatConversationResult } from "./format-result.js";
import { waitForRunEvent } from "../../../lib/run-subscribers.js";
import {
  RUN_TESTS_DESCRIPTION,
  RUN_LOAD_TEST_DESCRIPTION,
  GET_RUN_STATUS_DESCRIPTION,
} from "../docs.js";

function hashIdempotencyKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function registerActionTools(
  server: McpServer,
  app: FastifyInstance,
  apiKeyId: string,
  userId: string,
) {
  // --- Tool: voiceci_run_tests ---
  server.registerTool("voiceci_run_tests", {
    title: "Run Tests",
    description: RUN_TESTS_DESCRIPTION,
    inputSchema: {
      config: z.object({
        adapter: AdapterTypeSchema.default("websocket").describe("Transport adapter: websocket, sip, webrtc, vapi, retell, elevenlabs, bland."),
        agent_url: z.string().optional().describe("URL of the deployed agent (wss:// or https://)."),
        agent_port: z.number().int().min(1).max(65535).optional().describe("Local agent port for relay. Default 3001."),
        conversation_tests: z.array(ConversationTestSpecSchema).optional().describe("Conversation test scenarios."),
        red_team: z.array(RedTeamAttackSchema).optional().describe("Red team attack types to run."),
        start_command: z.string().optional().describe("Shell command to start the local agent."),
        health_endpoint: z.string().optional().describe("Health check endpoint path."),
        target_phone_number: z.string().optional().describe("Phone number for SIP/telephony adapters."),
        voice: z.record(z.unknown()).optional().describe("Voice/audio configuration overrides."),
        caller_audio: CallerAudioEffectsSchema.optional().describe("Default audio effects applied to all caller audio."),
        platform: PlatformConfigSchema.optional().describe("Platform config for vapi/retell/elevenlabs/bland."),
      }).refine(
        (d) => (d.conversation_tests?.length ?? 0) + (d.red_team?.length ?? 0) > 0,
        { message: "At least one of conversation_tests or red_team is required." }
      ).describe("Test configuration object. Generate this inline — see voiceci_guide_reference for the full schema."),
      idempotency_key: z
        .string()
        .uuid()
        .optional()
        .describe("Optional UUID to prevent duplicate runs on retries."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (
    {
      config,
      idempotency_key,
    },
  ) => {

    const hashedIdempotencyKey = idempotency_key
      ? hashIdempotencyKey(idempotency_key)
      : null;

    // Idempotency check — return existing run if key matches
    if (hashedIdempotencyKey) {
      const [existing] = await app.db
        .select({ id: schema.runs.id, status: schema.runs.status })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.user_id, userId),
            eq(schema.runs.idempotency_key, hashedIdempotencyKey),
          ),
        )
        .limit(1);

      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ run_id: existing.id, status: existing.status, deduplicated: true }, null, 2),
            },
          ],
        };
      }
    }

    const apiUrl = process.env["API_URL"] ?? "https://voiceci-api.fly.dev";

    // Helper to build test spec from config object
    const buildTestSpec = (cfg: Record<string, unknown>) => {
      const adapter = (cfg.adapter as string) ?? "websocket";
      const agentUrl = cfg.agent_url as string | undefined;
      const voice = cfg.voice as Record<string, unknown> | undefined;
      const targetPhoneNumber = cfg.target_phone_number as string | undefined;
      const voiceConfig = voice
        ? { adapter, target_phone_number: targetPhoneNumber, voice }
        : { adapter, target_phone_number: targetPhoneNumber };

      // Merge root-level caller_audio as default onto conversation tests
      const callerAudio = cfg.caller_audio as Record<string, unknown> | undefined;
      let conversationTests = cfg.conversation_tests as Record<string, unknown>[] | null | undefined;
      if (callerAudio && Array.isArray(conversationTests)) {
        conversationTests = conversationTests.map((test) => {
          if (test.caller_audio === undefined) {
            return { ...test, caller_audio: callerAudio };
          }
          return test;
        });
      }

      return {
        testSpecJson: {
          conversation_tests: conversationTests ?? null,
          red_team: cfg.red_team ?? null,
          adapter,
          voice_config: voiceConfig,
          start_command: cfg.start_command ?? null,
          health_endpoint: cfg.health_endpoint ?? null,
          agent_url: agentUrl ?? null,
          target_phone_number: targetPhoneNumber ?? null,
          platform: cfg.platform ?? null,
        },
        adapter,
        agentUrl,
        voiceConfig,
        targetPhoneNumber,
        conversationTests: conversationTests ?? null,
        isRemote: ["vapi", "retell", "elevenlabs", "bland"].includes(adapter)
          || adapter === "sip" || adapter === "webrtc" || !!agentUrl,
      };
    };

    // Config is already validated by Zod schema — safe to cast
    const cfg = config as Record<string, unknown>;

    const { testSpecJson, adapter, agentUrl, voiceConfig, targetPhoneNumber, conversationTests, isRemote } = buildTestSpec(cfg);

    if (isRemote) {
      // Remote/deployed agent — queue immediately, no bash needed
      const [run] = await app.db
        .insert(schema.runs)
        .values({
          api_key_id: apiKeyId,
          user_id: userId,
          source_type: "remote",
          bundle_key: null,
          bundle_hash: "remote",
          status: "queued",
          test_spec_json: testSpecJson,
          idempotency_key: hashedIdempotencyKey,
        })
        .returning();

      const runId = run!.id;


      await app.getRunQueue(userId).add("execute-run", {
        run_id: runId,
        bundle_key: null,
        bundle_hash: null,
        lockfile_hash: null,
        adapter,
        test_spec: {
          conversation_tests: conversationTests ?? null,
          red_team: cfg.red_team ?? null,
        },
        target_phone_number: targetPhoneNumber,
        voice_config: voiceConfig,
        start_command: cfg.start_command as string | undefined,
        health_endpoint: cfg.health_endpoint as string | undefined,
        agent_url: agentUrl,
        platform: cfg.platform ?? null,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            run_id: runId,
            status: "queued",
            message: "Run queued. Spawn one subagent per conversation test. Each subagent calls voiceci_get_run_status with test_type=conversation and returns when done. After all subagents return, call voiceci_get_run_status once without filters for the full summary.",
          }, null, 2),
        }],
      };
    }

    // Local WebSocket agent — store config in DB, return relay command
    const relayToken = randomUUID();
    const startCommand = cfg.start_command as string | undefined;

    const [run] = await app.db
      .insert(schema.runs)
      .values({
        api_key_id: apiKeyId,
        user_id: userId,
        source_type: "relay",
        bundle_key: null,
        bundle_hash: null,
        status: "queued",
        test_spec_json: testSpecJson,
        idempotency_key: hashedIdempotencyKey,
        relay_token: relayToken,
      })
      .returning();

    const runId = run!.id;

    const agentPort = (cfg.agent_port as number | undefined) ?? 3001;

    const relayArgs = [
      "--run-id",
      runId,
      "--token",
      relayToken,
      "--api-url",
      apiUrl,
      "--agent-port",
      String(agentPort),
    ];
    if (startCommand) {
      relayArgs.push("--start-command", startCommand);
    }
    if (cfg.health_endpoint) {
      relayArgs.push("--health-endpoint", String(cfg.health_endpoint));
    }

    const relayCommand = `lsof -ti:${agentPort} | xargs kill -9 2>/dev/null; curl -sS ${shellEscape(`${apiUrl}/relay/client.mjs`)} -o /tmp/voiceci-relay.mjs && node /tmp/voiceci-relay.mjs ${relayArgs.map((arg) => shellEscape(arg)).join(" ")}`;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          run_id: runId,
          status: "queued",
          relay_command: relayCommand,
          message: "Run queued. Execute the relay_command in the BACKGROUND (is_background: true). Execute EXACTLY ONCE — do NOT retry, re-run, or run npm install. After backgrounding, spawn subagents to monitor results via voiceci_get_run_status.",
        }, null, 2),
      }],
    };
  });

  // --- Tool: voiceci_run_load_test ---
  server.registerTool("voiceci_run_load_test", {
    title: "Run Load Test",
    description: RUN_LOAD_TEST_DESCRIPTION,
    inputSchema: {
      adapter: AdapterTypeSchema.describe("Transport: websocket, sip, or webrtc."),
      agent_url: z.string().describe("URL of the already-deployed agent to test."),
      target_concurrency: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe("Maximum concurrent calls. Tiers fire at 10%, 25%, 50%, 100% of this value."),
      caller_prompt: z
        .string()
        .min(1)
        .describe("Persona prompt for CallerLLM. Each concurrent caller generates a unique utterance from this prompt."),
      max_turns: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Conversation turns per call (default 6). Every call is a full multi-turn conversation."),
      eval: z
        .array(z.string().min(1))
        .optional()
        .describe("Eval questions for post-call quality scoring. Each call's transcript is judged against these."),
      thresholds: LoadTestThresholdsSchema
        .partial()
        .optional()
        .describe("Override default severity thresholds. Each field is [excellent, good, acceptable]."),
      target_phone_number: z
        .string()
        .optional()
        .describe("Phone number to call. Required for SIP adapter."),
      voice: z
        .object({
          tts: z.object({ voice_id: z.string().optional() }).optional(),
          stt: z.object({ api_key_env: z.string().optional() }).optional(),
          silence_threshold_ms: z.number().optional(),
          webrtc: z.object({
            livekit_url_env: z.string().optional(),
            api_key_env: z.string().optional(),
            api_secret_env: z.string().optional(),
            room: z.string().optional(),
          }).optional(),
          telephony: z.object({
            auth_id_env: z.string().optional(),
            auth_token_env: z.string().optional(),
            from_number: z.string().optional(),
          }).optional(),
        })
        .optional()
        .describe("Voice configuration overrides."),
      caller_audio: CallerAudioPoolSchema
        .optional()
        .describe("Audio condition simulation for callers. By default, values are randomized per caller from ranges/arrays. Use exact values to make all callers identical. Effects: noise (babble/white/pink + SNR), speed (0.5-2.0), speakerphone (bandpass 300-3400Hz), mic_distance (close/normal/far), clarity (0-1), accent (american/british/australian/etc), packet_loss (0-0.3), jitter_ms (0-100)."),
      language: z
        .string()
        .min(2)
        .max(5)
        .optional()
        .describe("ISO 639-1 language code for multilingual load testing. Supported: en, es, fr, de, it, nl, ja."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (
    {
      adapter,
      agent_url,
      target_concurrency,
      caller_prompt,
      max_turns,
      eval: evalQuestions,
      thresholds,
      target_phone_number,
      voice,
      caller_audio,
      language,
    },
  ) => {
    const runId = await runLoadTestInProcess(
      {
        channelConfig: {
          adapter,
          agentUrl: agent_url,
          targetPhoneNumber: target_phone_number,
          voice,
        },
        targetConcurrency: target_concurrency,
        callerPrompt: caller_prompt,
        maxTurns: max_turns,
        evalQuestions,
        thresholds,
        callerAudioPool: caller_audio,
        language,
      },
      app,
      apiKeyId,
      userId,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            run_id: runId,
            status: "running",
            target_concurrency,
            message: "Load test started. Tiers will fire at increasing concurrency levels. Use voiceci_get_run_status with this run_id and test_type='load_test' to get results via long-polling.",
          }, null, 2),
        },
      ],
    };
  });

  // --- Tool: voiceci_get_run_status ---
  server.registerTool("voiceci_get_run_status", {
    title: "Get Run Status",
    description: GET_RUN_STATUS_DESCRIPTION,
    inputSchema: {
      run_id: z.string().uuid().describe("The run ID returned by voiceci_run_tests."),
      last_completed: z.number().int().min(0).optional().describe("Number of completed tests (of the filtered type) from your last status check. Pass the `completed` value from the previous response."),
      test_type: z.enum(["conversation", "load_test"]).optional().describe("Filter results to a single test type. Use with subagents for conversation or load_test polling."),
      test_name: z.string().optional().describe("Filter to a specific test by name. Spawn one subagent per test_name for parallel result streaming."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ run_id, last_completed, test_type, test_name }) => {
    let [run] = await app.db
      .select()
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.id, run_id),
          eq(schema.runs.user_id, userId),
        ),
      )
      .limit(1);

    if (!run) {
      return {
        content: [{ type: "text" as const, text: `Error: Run ${run_id} not found.` }],
        isError: true,
      };
    }

    // Build WHERE clause for scenario queries — scoped by test_name or test_type when filtered
    const scenarioWhere = test_name
      ? and(eq(schema.scenarioResults.run_id, run_id), eq(schema.scenarioResults.name, test_name))
      : test_type
        ? and(eq(schema.scenarioResults.run_id, run_id), eq(schema.scenarioResults.test_type, test_type))
        : eq(schema.scenarioResults.run_id, run_id);

    // Long-poll: block until meaningful state change (new results or status change).
    // Returns immediately when new results exist (delta delivery via last_completed).
    // When test_type is set, only counts results of that type — enabling parallel subagent polling.
    if (run.status === "queued" || run.status === "running") {
      const previousCount = last_completed ?? (await app.db
        .select()
        .from(schema.scenarioResults)
        .where(scenarioWhere)).length;
      const startTime = Date.now();
      const MAX_WAIT_MS = 45_000;

      while (Date.now() - startTime < MAX_WAIT_MS) {
        // Register waiter BEFORE checking DB (avoids race condition)
        const { promise, cancel } = waitForRunEvent(run_id);

        // Re-fetch run status
        const [freshRun] = await app.db
          .select()
          .from(schema.runs)
          .where(and(eq(schema.runs.id, run_id), eq(schema.runs.user_id, userId)))
          .limit(1);
        if (freshRun) run = freshRun;

        // Status changed (completed/failed) — return immediately
        if (run.status !== "queued" && run.status !== "running") {
          cancel();
          break;
        }

        // Check if new partial results arrived (filtered by test_type if set)
        const currentPartials = await app.db
          .select()
          .from(schema.scenarioResults)
          .where(scenarioWhere);
        if (currentPartials.length > previousCount) {
          cancel();
          break;
        }

        // No meaningful change — wait for next event or 10s timeout
        let timeoutId: ReturnType<typeof setTimeout>;
        const timeout = new Promise<void>(r => { timeoutId = setTimeout(r, 10_000); });
        await Promise.race([promise, timeout]);
        cancel();
        clearTimeout(timeoutId!);
      }
    }

    // ---- Fetch results in creation order, compute delta ----
    // When test_type is set, only fetches that type (parallel subagent mode).
    const allScenarios = await app.db
      .select()
      .from(schema.scenarioResults)
      .where(scenarioWhere)
      .orderBy(asc(schema.scenarioResults.created_at));

    const previouslySeen = last_completed ?? 0;
    const newScenarios = allScenarios.slice(previouslySeen);
    const totalCompleted = allScenarios.length;

    // Categorize new results — when filtered by test_type, only that type is present
    const conversationResults = newScenarios
      .filter((s) => s.test_type === "conversation")
      .map((s) => formatConversationResult(s.metrics_json))
      .filter(Boolean);
    const loadTestResults = newScenarios
      .filter((s) => s.test_type === "load_test")
      .map((s) => s.metrics_json);

    const isFinished = run.status !== "queued" && run.status !== "running";

    // Still in progress — return delta + progress info
    if (!isFinished) {
      const spec = run.test_spec_json as {
        conversation_tests?: unknown[];
        red_team?: RedTeamAttack[];
        load_test?: unknown;
      } | null;
      let redTeamExpanded = 0;
      if (spec?.red_team) {
        try {
          redTeamExpanded = expandRedTeamTests(spec.red_team).length;
        } catch {
          redTeamExpanded = 0;
        }
      }
      // Sum repeat counts to get true number of conversation tasks dispatched
      const convCount = (spec?.conversation_tests as Array<{ repeat?: number }> | undefined)?.reduce(
        (sum, test) => sum + (test.repeat ?? 1), 0
      ) ?? 0;
      const loadCount = spec?.load_test ? 1 : 0;
      const totalTests = spec
        ? test_name ? 1
          : test_type === "conversation" ? convCount + redTeamExpanded
          : test_type === "load_test" ? loadCount
          : convCount + redTeamExpanded + loadCount
        : undefined;

      if (totalCompleted === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              run_id: run.id,
              status: run.status,
              completed: 0,
              total: totalTests ?? "unknown",
              started_at: run.started_at,
              message: run.status === "queued"
                ? "Run is queued, waiting for execution. Call again immediately — this tool long-polls."
                : "Run is in progress. No test results yet. Call again immediately — this tool long-polls.",
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            run_id: run.id,
            status: run.status,
            completed: totalCompleted,
            total: totalTests ?? "unknown",
            started_at: run.started_at,
            conversation_results: conversationResults,
            load_test_results: loadTestResults,
            message: `${newScenarios.length} new result(s) completed (${totalCompleted}${totalTests ? `/${totalTests}` : ""} total).${totalCompleted >= (totalTests ?? Infinity) ? "" : ` Call again with last_completed=${totalCompleted}.`}`,
          }, null, 2),
        }],
      };
    }

    // ---- Run completed — return delta + final summary ----

    // When filtered by test_name or test_type (subagent mode), return just the scoped results.
    // Fix plan + baseline are only computed for unfiltered calls (main agent).
    if (test_name || test_type) {
      const filterLabel = test_name ?? test_type;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            run_id: run.id,
            status: run.status,
            completed: totalCompleted,
            conversation_results: conversationResults,
            load_test_results: loadTestResults,
            error_text: run.error_text ?? null,
            duration_ms: run.duration_ms,
            started_at: run.started_at,
            finished_at: run.finished_at,
            message: newScenarios.length > 0
              ? `Run complete. ${newScenarios.length} ${filterLabel} result(s).`
              : `Run complete. All ${totalCompleted} ${filterLabel} results already delivered.`,
          }, null, 2),
        }],
      };
    }

    // Unfiltered (main agent) — build fix_plan over ALL results
    const allConversationResults = (await app.db
      .select()
      .from(schema.scenarioResults)
      .where(and(eq(schema.scenarioResults.run_id, run_id), eq(schema.scenarioResults.test_type, "conversation"))))
      .map((s) => s.metrics_json);
    const fixPlan = buildFixPlan({
      conversationResults: allConversationResults,
      testSpecJson: (run.test_spec_json as Record<string, unknown> | null) ?? null,
    });

    // Baseline comparison — find most recent baseline and compute deltas
    let baselineComparison: Record<string, unknown> | null = null;
    try {
      const [baseline] = await app.db
        .select({ run_id: schema.baselines.run_id, created_at: schema.baselines.created_at })
        .from(schema.baselines)
        .where(eq(schema.baselines.user_id, userId))
        .orderBy(desc(schema.baselines.created_at))
        .limit(1);

      if (baseline && baseline.run_id !== run_id) {
        const baselineScenarios = await app.db
          .select()
          .from(schema.scenarioResults)
          .where(eq(schema.scenarioResults.run_id, baseline.run_id));

        const bConv = baselineScenarios.filter((s) => s.test_type === "conversation");
        const currentConvScenarios = allScenarios.filter((s) => s.test_type === "conversation");

        const convPassRate = currentConvScenarios.length > 0
          ? currentConvScenarios.filter((s) => s.status === "pass").length / currentConvScenarios.length
          : null;
        const bConvPassRate = bConv.length > 0
          ? bConv.filter((s) => s.status === "pass").length / bConv.length
          : null;

        const extractMetricMean = (results: unknown[], path: (r: Record<string, unknown>) => number | undefined): number | null => {
          const values = results
            .filter((r): r is Record<string, unknown> => r != null && typeof r === "object")
            .map(path)
            .filter((v): v is number => v != null && v > 0);
          return values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
        };

        const currentTtfb = extractMetricMean(allConversationResults, (r) => (r as { metrics?: { mean_ttfb_ms?: number } }).metrics?.mean_ttfb_ms);
        const baselineTtfb = extractMetricMean(bConv.map((s) => s.metrics_json), (r) => (r as { metrics?: { mean_ttfb_ms?: number } }).metrics?.mean_ttfb_ms);

        const currentTtfw = extractMetricMean(allConversationResults, (r) => (r as { metrics?: { mean_ttfw_ms?: number } }).metrics?.mean_ttfw_ms);
        const baselineTtfw = extractMetricMean(bConv.map((s) => s.metrics_json), (r) => (r as { metrics?: { mean_ttfw_ms?: number } }).metrics?.mean_ttfw_ms);

        const ttfbDelta = currentTtfb != null && baselineTtfb != null ? currentTtfb - baselineTtfb : null;
        const ttfwDelta = currentTtfw != null && baselineTtfw != null ? currentTtfw - baselineTtfw : null;
        const convPassDelta = convPassRate != null && bConvPassRate != null
          ? Math.round((convPassRate - bConvPassRate) * 100) / 100
          : null;

        const regressionDetected =
          (ttfbDelta != null && ttfbDelta > 500) ||
          (ttfwDelta != null && ttfwDelta > 500) ||
          (convPassDelta != null && convPassDelta < -0.1);

        baselineComparison = {
          baseline_run_id: baseline.run_id,
          baseline_created_at: baseline.created_at,
          mean_ttfb_delta_ms: ttfbDelta,
          mean_ttfw_delta_ms: ttfwDelta,
          conversation_pass_rate_delta: convPassDelta,
          regression_detected: regressionDetected,
        };
      }
    } catch {
      // Best-effort — don't fail status retrieval if baseline comparison fails
    }

    app.log.debug({
      run_id: run.id,
      run_status: run.status,
      new_results: newScenarios.length,
      total_completed: totalCompleted,
      fix_plan_present: fixPlan != null,
      failing_tests: fixPlan?.failing_tests ?? 0,
      top_priority: fixPlan?.top_priority ?? null,
    }, "Run completed — returning final delta");

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          run_id: run.id,
          status: run.status,
          completed: totalCompleted,
          aggregate: run.aggregate_json,
          conversation_results: conversationResults,
          load_test_results: loadTestResults,
          fix_plan: fixPlan,
          baseline_comparison: baselineComparison,
          error_text: run.error_text ?? null,
          duration_ms: run.duration_ms,
          started_at: run.started_at,
          finished_at: run.finished_at,
          message: newScenarios.length > 0
            ? `Run complete. ${newScenarios.length} final result(s).`
            : `Run complete. All ${totalCompleted} results already delivered incrementally.`,
        }, null, 2),
      }],
    };
  });
}
