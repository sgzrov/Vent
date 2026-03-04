import type { FastifyInstance } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID, createHash } from "node:crypto";
import { eq, and, desc, asc } from "drizzle-orm";
import { schema } from "@voiceci/db";
import { z } from "zod";
import {
  AdapterTypeSchema,
  LoadPatternSchema,
  type RedTeamAttack,
} from "@voiceci/shared";
import { expandRedTeamTests } from "@voiceci/runner/executor";
import { runLoadTestInProcess } from "../../../services/test-runner.js";
import { buildFixPlan } from "./fix-plan.js";
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
      config: z
        .any()
        .describe("Config from voiceci-config.json. Read the file and pass its contents here."),
      project_root: z
        .string()
        .optional()
        .describe("Absolute path to agent project root containing voiceci-config.json. Defaults to current working directory."),
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
      project_root,
      idempotency_key,
    },
  ) => {
    void project_root;

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

      return {
        testSpecJson: {
          infrastructure: cfg.infrastructure ?? null,
          conversation_tests: cfg.conversation_tests ?? null,
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
        isRemote: ["vapi", "retell", "elevenlabs", "bland"].includes(adapter)
          || adapter === "sip" || adapter === "webrtc" || !!agentUrl,
      };
    };

    if (!config) {
      return {
        content: [{
          type: "text" as const,
          text: "Error: config parameter is required. Read voiceci-config.json and pass its contents as the config parameter.",
        }],
        isError: true,
      };
    }

    let cfg: Record<string, unknown>;
    if (typeof config === "string") {
      try {
        const parsed = JSON.parse(config) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: config must be a JSON object.",
            }],
            isError: true,
          };
        }
        cfg = parsed as Record<string, unknown>;
      } catch {
        return {
          content: [{
            type: "text" as const,
            text: "Error: config string is not valid JSON.",
          }],
          isError: true,
        };
      }
    } else if (typeof config === "object" && config !== null && !Array.isArray(config)) {
      cfg = config as Record<string, unknown>;
    } else {
      return {
        content: [{
          type: "text" as const,
          text: "Error: config must be an object.",
        }],
        isError: true,
      };
    }

    const { testSpecJson, adapter, agentUrl, voiceConfig, targetPhoneNumber, isRemote } = buildTestSpec(cfg);

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
          infrastructure: cfg.infrastructure ?? null,
          conversation_tests: cfg.conversation_tests ?? null,
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
            message: "Run queued. Spawn one subagent per infrastructure probe (test_name: audio_quality, latency, echo) and one per conversation test. Each subagent calls voiceci_get_run_status with its filter and returns when done. After all subagents return, call voiceci_get_run_status once without filters for the full summary.",
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

    const agentPort = 3001;

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
        text: `ACTION REQUIRED: Run this command in the project root to start your agent and connect to VoiceCI for testing. The run will NOT proceed until you execute this command.\n\n${relayCommand}\n\nThe relay client will start your agent, connect to VoiceCI, and tests will run against your local agent. After executing, spawn subagents to monitor results via voiceci_get_run_status with run_id: ${runId}`,
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
      pattern: LoadPatternSchema.describe(
        "Traffic pattern: ramp (linear 0→target), spike (1→target instantly), sustained (full immediately), soak (slow ramp, long hold)"
      ),
      target_concurrency: z
        .number()
        .int()
        .min(1)
        .max(500)
        .describe("Maximum concurrent calls to maintain"),
      total_duration_s: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .describe("Total test duration in seconds"),
      ramp_duration_s: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Duration of ramp-up phase in seconds (default: 30% of total_duration_s)"),
      caller_prompt: z
        .string()
        .min(1)
        .describe("What the simulated caller says. Pre-synthesized once and replayed for all callers."),
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
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (
    {
      adapter,
      agent_url,
      pattern,
      target_concurrency,
      total_duration_s,
      ramp_duration_s,
      caller_prompt,
      target_phone_number,
      voice,
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
        pattern,
        targetConcurrency: target_concurrency,
        totalDurationS: total_duration_s,
        rampDurationS: ramp_duration_s,
        callerPrompt: caller_prompt,
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
            pattern,
            target_concurrency,
            total_duration_s,
            message: "Load test started. Use voiceci_get_run_status with this run_id and test_type='load_test' to get results via long-polling.",
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
      test_type: z.enum(["infrastructure", "conversation", "load_test"]).optional().describe("Filter results to a single test type. 'infrastructure' filters to Layer 1 probes (completed/error status). Use with subagents for conversation or load_test polling."),
      test_name: z.string().optional().describe("Filter to a specific infrastructure probe by name (audio_quality, latency, echo). Spawn one subagent per test_name for parallel result streaming."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ run_id, last_completed, test_type: rawTestType, test_name }) => {
    // Map user-facing "infrastructure" to DB enum "audio"
    const test_type = rawTestType === "infrastructure" ? "audio" : rawTestType;

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
      ? and(eq(schema.scenarioResults.run_id, run_id), eq(schema.scenarioResults.test_type, "audio"), eq(schema.scenarioResults.name, test_name))
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
      const MAX_WAIT_MS = 60_000;

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
    const infrastructureResults = newScenarios
      .filter((s) => s.test_type === "audio")
      .map((s) => s.metrics_json);
    const conversationResults = newScenarios
      .filter((s) => s.test_type === "conversation")
      .map((s) => s.metrics_json);
    const loadTestResults = newScenarios
      .filter((s) => s.test_type === "load_test")
      .map((s) => s.metrics_json);

    const isFinished = run.status !== "queued" && run.status !== "running";

    // Still in progress — return delta + progress info
    if (!isFinished) {
      const spec = run.test_spec_json as {
        infrastructure?: Record<string, unknown>;
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
      // When filtering by test_name, total is always 1; by test_type, count that type only
      // Infrastructure always runs 3 probes (audio_quality, latency, echo) when configured
      const infraCount = spec?.infrastructure ? 3 : 0;
      const convCount = spec?.conversation_tests?.length ?? 0;
      const loadCount = spec?.load_test ? 1 : 0;
      const totalTests = spec
        ? test_name ? 1
          : test_type === "audio" ? infraCount
          : test_type === "conversation" ? convCount + redTeamExpanded
          : test_type === "load_test" ? loadCount
          : infraCount + convCount + redTeamExpanded + loadCount
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
            infrastructure_results: infrastructureResults,
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
      const filterLabel = test_name ?? (rawTestType ?? test_type);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            run_id: run.id,
            status: run.status,
            completed: totalCompleted,
            infrastructure_results: infrastructureResults,
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
    const allInfrastructureResults = (await app.db
      .select()
      .from(schema.scenarioResults)
      .where(and(eq(schema.scenarioResults.run_id, run_id), eq(schema.scenarioResults.test_type, "audio"))))
      .map((s) => s.metrics_json);
    const allConversationResults = (await app.db
      .select()
      .from(schema.scenarioResults)
      .where(and(eq(schema.scenarioResults.run_id, run_id), eq(schema.scenarioResults.test_type, "conversation"))))
      .map((s) => s.metrics_json);
    const fixPlan = buildFixPlan({
      audioResults: allInfrastructureResults,
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

        const bInfra = baselineScenarios.filter((s) => s.test_type === "audio");
        const bConv = baselineScenarios.filter((s) => s.test_type === "conversation");
        const currentInfraScenarios = allScenarios.filter((s) => s.test_type === "audio");
        const currentConvScenarios = allScenarios.filter((s) => s.test_type === "conversation");

        // Infrastructure probes use completed/error, not pass/fail
        const infraCompletedRate = currentInfraScenarios.length > 0
          ? currentInfraScenarios.filter((s) => s.status === "completed").length / currentInfraScenarios.length
          : null;
        const bInfraCompletedRate = bInfra.length > 0
          ? bInfra.filter((s) => s.status === "completed").length / bInfra.length
          : null;
        const convPassRate = currentConvScenarios.length > 0
          ? currentConvScenarios.filter((s) => s.status === "pass").length / currentConvScenarios.length
          : null;
        const bConvPassRate = bConv.length > 0
          ? bConv.filter((s) => s.status === "pass").length / bConv.length
          : null;

        const extractMeanTtfb = (results: unknown[]): number | null => {
          const ttfbs = results
            .filter((r): r is Record<string, unknown> => r != null && typeof r === "object")
            .map((r) => (r as { metrics?: { mean_ttfb_ms?: number } }).metrics?.mean_ttfb_ms)
            .filter((v): v is number => v != null && v > 0);
          return ttfbs.length > 0 ? Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length) : null;
        };

        const currentTtfb = extractMeanTtfb(allConversationResults);
        const baselineTtfb = extractMeanTtfb(bConv.map((s) => s.metrics_json));

        const ttfbDelta = currentTtfb != null && baselineTtfb != null ? currentTtfb - baselineTtfb : null;
        const infraCompletedDelta = infraCompletedRate != null && bInfraCompletedRate != null
          ? Math.round((infraCompletedRate - bInfraCompletedRate) * 100) / 100
          : null;
        const convPassDelta = convPassRate != null && bConvPassRate != null
          ? Math.round((convPassRate - bConvPassRate) * 100) / 100
          : null;

        const regressionDetected =
          (ttfbDelta != null && ttfbDelta > 500) ||
          (infraCompletedDelta != null && infraCompletedDelta < -0.1) ||
          (convPassDelta != null && convPassDelta < -0.1);

        baselineComparison = {
          baseline_run_id: baseline.run_id,
          baseline_created_at: baseline.created_at,
          mean_ttfb_delta_ms: ttfbDelta,
          infrastructure_completed_rate_delta: infraCompletedDelta,
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
          infrastructure_results: infrastructureResults,
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
