import type { FastifyInstance } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID, createHash } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
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
    description: "Run audio and conversation tests against a voice agent. Requires a `voiceci/` folder in the project root with `audio.json` and/or `conversations.json`.\n\nRead all JSON files in the `voiceci/` folder, merge them into one config object, then pass the merged object as the `config` parameter. For already-deployed agents (SIP, WebRTC, platform adapters, or agent_url), this queues immediately — no bash step. For local WebSocket agents with start_command, a relay command is returned to connect your local agent.\n\nThen poll voiceci_get_run_status with the run_id.",
    inputSchema: {
      config: z
        .any()
        .describe("Merged config from voiceci/ folder. Read all JSON files in voiceci/, merge them into one object, then pass it here."),
      project_root: z
        .string()
        .optional()
        .describe("Absolute path to agent project root containing the voiceci/ folder. Defaults to current working directory."),
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
          audio_tests: cfg.audio_tests ?? null,
          conversation_tests: cfg.conversation_tests ?? null,
          red_team: cfg.red_team ?? null,
          adapter,
          voice_config: voiceConfig,
          audio_test_thresholds: cfg.audio_test_thresholds ?? null,
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
          text: "Error: config parameter is required. Read all JSON files from the voiceci/ folder, merge them, and pass the merged object as the config parameter.",
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
          audio_tests: cfg.audio_tests ?? null,
          conversation_tests: cfg.conversation_tests ?? null,
          red_team: cfg.red_team ?? null,
        },
        target_phone_number: targetPhoneNumber,
        voice_config: voiceConfig,
        audio_test_thresholds: cfg.audio_test_thresholds ?? null,
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
            message: "Run queued. Poll voiceci_get_run_status with the run_id.",
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

    const relayCommand = `curl -sS ${shellEscape(`${apiUrl}/relay/client.mjs`)} -o /tmp/voiceci-relay.mjs && node /tmp/voiceci-relay.mjs ${relayArgs.map((arg) => shellEscape(arg)).join(" ")}`;

    return {
      content: [{
        type: "text" as const,
        text: `ACTION REQUIRED: Run this command in the project root to start your agent and connect to VoiceCI for testing. The run will NOT proceed until you execute this command.\n\n${relayCommand}\n\nThe relay client will start your agent, connect to VoiceCI, and tests will run against your local agent. After tests complete, poll voiceci_get_run_status with run_id: ${runId}`,
      }],
    };
  });

  // --- Tool: voiceci_run_load_test ---
  server.registerTool("voiceci_run_load_test", {
    title: "Run Load Test",
    description: "Run a load/stress test against an already-deployed voice agent. Sends N concurrent calls with a traffic pattern (ramp, spike, sustained, soak). Measures TTFB percentiles, error rates, and auto-detects breaking point. Results pushed via SSE as timeline snapshots every second. Only works with already-deployed agents (SIP, WebRTC, or websocket with agent_url).",
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
            message: "Load test running. Poll voiceci_get_run_status with the run_id for progress and results.",
          }, null, 2),
        },
      ],
    };
  });

  // --- Tool: voiceci_get_run_status ---
  server.registerTool("voiceci_get_run_status", {
    title: "Get Run Status",
    description: "Get the current status and results of a test run by ID. Uses long-polling — when the run is still in progress, the server waits up to 10 seconds for new results before responding, reducing unnecessary round-trips. Returns partial results as individual tests complete, so you can reason about early failures while other tests are still running. Once the run finishes, returns the full aggregate summary and all results. When failures exist, response includes `fix_plan` with prioritized failure packets and a `targeted_rerun_config`.",
    inputSchema: {
      run_id: z.string().uuid().describe("The run ID returned by voiceci_run_tests."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ run_id }) => {
    // Register waiter BEFORE querying DB to avoid race condition:
    // if a broadcast fires between the DB check and registration, we'd miss it.
    const { promise: waitPromise, cancel: cancelWait } = waitForRunEvent(run_id);

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
      cancelWait();
      return {
        content: [{ type: "text" as const, text: `Error: Run ${run_id} not found.` }],
        isError: true,
      };
    }

    // Long-poll: if run is in progress, wait for the next broadcast signal
    if (run.status === "queued" || run.status === "running") {
      await waitPromise;

      // Re-fetch run — status may have changed during the wait
      const [freshRun] = await app.db
        .select()
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.id, run_id),
            eq(schema.runs.user_id, userId),
          ),
        )
        .limit(1);
      if (freshRun) run = freshRun;
    } else {
      // Run already completed — cancel the waiter
      cancelWait();
    }

    // Still in progress — return partial results if available
    if (run.status === "queued" || run.status === "running") {
      const partialResults = await app.db
        .select()
        .from(schema.scenarioResults)
        .where(eq(schema.scenarioResults.run_id, run_id));

      // Derive total test count from stored config
      const spec = run.test_spec_json as {
        audio_tests?: unknown[];
        conversation_tests?: unknown[];
        red_team?: RedTeamAttack[];
      } | null;
      let redTeamExpanded = 0;
      if (spec?.red_team) {
        try {
          redTeamExpanded = expandRedTeamTests(spec.red_team).length;
        } catch {
          redTeamExpanded = 0;
        }
      }
      const totalTests = spec
        ? (spec.audio_tests?.length ?? 0) + (spec.conversation_tests?.length ?? 0) + redTeamExpanded
        : undefined;

      // Estimate remaining time from test counts
      const audioCount = spec?.audio_tests?.length ?? 0;
      const convCount = spec?.conversation_tests?.length ?? 0;
      const totalEstimateS = audioCount * 30 + convCount * 45 + redTeamExpanded * 60;
      const elapsedS = run.started_at
        ? Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000)
        : 0;
      const estimatedRemainingS = Math.max(0, totalEstimateS - elapsedS);
      const pollIntervalS = Math.min(10, Math.max(3, Math.round(estimatedRemainingS / 4)));

      if (partialResults.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              run_id: run.id,
              status: run.status,
              completed: 0,
              total: totalTests ?? "unknown",
              started_at: run.started_at,
              estimated_remaining_s: estimatedRemainingS,
              poll_interval_s: pollIntervalS,
              message: run.status === "queued"
                ? "Run is queued, waiting for execution."
                : "Run is in progress. No test results yet. Poll again in a few seconds.",
            }, null, 2),
          }],
        };
      }

      // Return completed tests so far
      const audioResults = partialResults
        .filter((s) => s.test_type === "audio")
        .map((s) => s.metrics_json);
      const conversationResults = partialResults
        .filter((s) => s.test_type === "conversation")
        .map((s) => s.metrics_json);
      const loadTestResults = partialResults
        .filter((s) => s.test_type === "load_test")
        .map((s) => s.metrics_json);
      const fixPlan = buildFixPlan({
        audioResults,
        conversationResults,
        testSpecJson: (run.test_spec_json as Record<string, unknown> | null) ?? null,
      });
      app.log.debug({
        run_id: run.id,
        run_status: run.status,
        completed: partialResults.length,
        total: totalTests ?? null,
        audio_results: audioResults.length,
        conversation_results: conversationResults.length,
        load_test_results: loadTestResults.length,
        fix_plan_present: fixPlan != null,
        failing_tests: fixPlan?.failing_tests ?? 0,
        top_priority: fixPlan?.top_priority ?? null,
      }, "Generated fix_plan for in-progress run");

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            run_id: run.id,
            status: run.status,
            completed: partialResults.length,
            total: totalTests ?? "unknown",
            started_at: run.started_at,
            audio_results: audioResults,
            conversation_results: conversationResults,
            load_test_results: loadTestResults,
            fix_plan: fixPlan,
            estimated_remaining_s: estimatedRemainingS,
            poll_interval_s: pollIntervalS,
            message: `Run in progress: ${partialResults.length}${totalTests ? `/${totalTests}` : ""} tests completed. Poll again for more results.`,
          }, null, 2),
        }],
      };
    }

    // Completed (pass or fail) — return full results
    const scenarios = await app.db
      .select()
      .from(schema.scenarioResults)
      .where(eq(schema.scenarioResults.run_id, run_id));

    const audioResults = scenarios
      .filter((s) => s.test_type === "audio")
      .map((s) => s.metrics_json);
    const conversationResults = scenarios
      .filter((s) => s.test_type === "conversation")
      .map((s) => s.metrics_json);
    const loadTestResults = scenarios
      .filter((s) => s.test_type === "load_test")
      .map((s) => s.metrics_json);
    const fixPlan = buildFixPlan({
      audioResults,
      conversationResults,
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

        const bAudio = baselineScenarios.filter((s) => s.test_type === "audio");
        const bConv = baselineScenarios.filter((s) => s.test_type === "conversation");
        const currentAudioScenarios = scenarios.filter((s) => s.test_type === "audio");
        const currentConvScenarios = scenarios.filter((s) => s.test_type === "conversation");

        const audioPassRate = currentAudioScenarios.length > 0
          ? currentAudioScenarios.filter((s) => s.status === "pass").length / currentAudioScenarios.length
          : null;
        const bAudioPassRate = bAudio.length > 0
          ? bAudio.filter((s) => s.status === "pass").length / bAudio.length
          : null;
        const convPassRate = currentConvScenarios.length > 0
          ? currentConvScenarios.filter((s) => s.status === "pass").length / currentConvScenarios.length
          : null;
        const bConvPassRate = bConv.length > 0
          ? bConv.filter((s) => s.status === "pass").length / bConv.length
          : null;

        // Extract mean TTFB from conversation results
        const extractMeanTtfb = (results: unknown[]): number | null => {
          const ttfbs = results
            .filter((r): r is Record<string, unknown> => r != null && typeof r === "object")
            .map((r) => (r as { metrics?: { mean_ttfb_ms?: number } }).metrics?.mean_ttfb_ms)
            .filter((v): v is number => v != null && v > 0);
          return ttfbs.length > 0 ? Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length) : null;
        };

        const currentTtfb = extractMeanTtfb(conversationResults);
        const baselineTtfb = extractMeanTtfb(bConv.map((s) => s.metrics_json));

        const ttfbDelta = currentTtfb != null && baselineTtfb != null ? currentTtfb - baselineTtfb : null;
        const audioPassDelta = audioPassRate != null && bAudioPassRate != null
          ? Math.round((audioPassRate - bAudioPassRate) * 100) / 100
          : null;
        const convPassDelta = convPassRate != null && bConvPassRate != null
          ? Math.round((convPassRate - bConvPassRate) * 100) / 100
          : null;

        const regressionDetected =
          (ttfbDelta != null && ttfbDelta > 500) ||
          (audioPassDelta != null && audioPassDelta < -0.1) ||
          (convPassDelta != null && convPassDelta < -0.1);

        baselineComparison = {
          baseline_run_id: baseline.run_id,
          baseline_created_at: baseline.created_at,
          mean_ttfb_delta_ms: ttfbDelta,
          audio_pass_rate_delta: audioPassDelta,
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
      audio_results: audioResults.length,
      conversation_results: conversationResults.length,
      load_test_results: loadTestResults.length,
      fix_plan_present: fixPlan != null,
      failing_tests: fixPlan?.failing_tests ?? 0,
      top_priority: fixPlan?.top_priority ?? null,
    }, "Generated fix_plan for completed run");

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          run_id: run.id,
          status: run.status,
          aggregate: run.aggregate_json,
          audio_results: audioResults,
          conversation_results: conversationResults,
          load_test_results: loadTestResults,
          fix_plan: fixPlan,
          baseline_comparison: baselineComparison,
          error_text: run.error_text ?? null,
          duration_ms: run.duration_ms,
          started_at: run.started_at,
          finished_at: run.finished_at,
        }, null, 2),
      }],
    };
  });
}
