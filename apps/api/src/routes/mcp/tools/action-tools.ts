import type { FastifyInstance } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID, createHash } from "node:crypto";
import { eq, and, asc } from "drizzle-orm";
import { schema } from "@voiceci/db";
import { z } from "zod";
import {
  AdapterTypeSchema,
  LoadTestSpecSchema,
  ConversationTestSpecSchema,
  PlatformConfigSchema,
  CallerAudioEffectsSchema,
} from "@voiceci/shared";

import { formatConversationResult } from "./format-result.js";
import { waitForRunEvent } from "../../../lib/run-subscribers.js";
import {
  RUN_TESTS_DESCRIPTION,
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
  // --- Tool: vent_run_tests ---
  server.registerTool("vent_run_tests", {
    title: "Run Tests",
    description: RUN_TESTS_DESCRIPTION,
    inputSchema: {
      config: z.object({
        connection: z.object({
          adapter: AdapterTypeSchema.default("websocket").describe("Transport adapter: websocket, sip, webrtc, vapi, retell, elevenlabs, bland."),
          agent_url: z.string().optional().describe("URL of the deployed agent (wss:// or https://)."),
          agent_port: z.number().int().min(1).max(65535).optional().describe("Local agent port for relay. Default 3001."),
          start_command: z.string().optional().describe("Shell command to start the local agent."),
          health_endpoint: z.string().optional().describe("Health check endpoint path."),
          target_phone_number: z.string().optional().describe("Phone number for SIP/telephony adapters."),
          caller_audio: CallerAudioEffectsSchema.optional().describe("Default audio effects applied to all caller audio."),
          platform: PlatformConfigSchema.optional().describe("Platform config for vapi/retell/elevenlabs/bland."),
        }).describe("Connection settings — how Vent reaches the agent."),
        conversation_tests: z.array(ConversationTestSpecSchema).optional().describe("Conversation test scenarios."),
        load_test: LoadTestSpecSchema.optional().describe("Load test configuration. Runs tiered concurrent calls (10%→25%→50%→100%) against the agent."),
      }).refine(
        (d) => (d.conversation_tests?.length ?? 0) > 0 || d.load_test != null,
        { message: "Exactly one of conversation_tests or load_test is required." }
      ).refine(
        (d) => !((d.conversation_tests?.length ?? 0) > 0 && d.load_test != null),
        { message: "conversation_tests and load_test cannot be used together." }
      ).describe("Test configuration object. Generate this inline — see vent_docs for the full schema."),
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
      const targetPhoneNumber = cfg.target_phone_number as string | undefined;
      const voiceConfig = { adapter, target_phone_number: targetPhoneNumber };

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
          load_test: cfg.load_test ?? null,
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

    // Flatten connection into cfg so buildTestSpec works uniformly
    const { connection, ...rest } = config as { connection: Record<string, unknown>; [k: string]: unknown };
    const cfg = { ...connection, ...rest } as Record<string, unknown>;

    const { testSpecJson, adapter, agentUrl, voiceConfig, targetPhoneNumber, conversationTests, isRemote } = buildTestSpec(cfg);

    // Build status message based on what test types are included
    const hasConv = (conversationTests?.length ?? 0) > 0;
    const hasLoad = !!cfg.load_test;
    let statusMessage = "Run queued.";
    if (hasConv) statusMessage += " Spawn one subagent per conversation test, each calling vent_get_run_status with test_type=conversation.";
    if (hasLoad) statusMessage += " Spawn one subagent for load test polling via vent_get_run_status with test_type=load_test.";
    statusMessage += " After all subagents return, call vent_get_run_status once without filters for the full summary.";

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
          load_test: cfg.load_test ?? null,
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
            message: statusMessage,
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

    // Queue BullMQ job immediately — don't depend on relay client's activate call
    await app.getRunQueue(userId).add("execute-run", {
      run_id: runId,
      bundle_key: null,
      bundle_hash: null,
      lockfile_hash: null,
      adapter,
      test_spec: {
        conversation_tests: conversationTests ?? null,
        load_test: cfg.load_test ?? null,
      },
      target_phone_number: targetPhoneNumber,
      voice_config: voiceConfig,
      start_command: startCommand,
      health_endpoint: cfg.health_endpoint as string | undefined,
      platform: cfg.platform ?? null,
      relay: true,
    });

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
          relay_config: {
            run_id: runId,
            relay_token: relayToken,
            api_url: apiUrl,
            agent_port: agentPort,
            start_command: startCommand ?? null,
            health_endpoint: (cfg.health_endpoint as string) ?? "/health",
          },
          relay_command: relayCommand,
          message: statusMessage,
        }, null, 2),
      }],
    };
  });


  // --- Tool: vent_get_run_status ---
  server.registerTool("vent_get_run_status", {
    title: "Get Run Status",
    description: GET_RUN_STATUS_DESCRIPTION,
    inputSchema: {
      run_id: z.string().uuid().describe("The run ID returned by vent_run_tests."),
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
        load_test?: unknown;
      } | null;
      // Sum repeat counts to get true number of conversation tasks dispatched
      const convCount = (spec?.conversation_tests as Array<{ repeat?: number }> | undefined)?.reduce(
        (sum, test) => sum + (test.repeat ?? 1), 0
      ) ?? 0;
      const loadCount = spec?.load_test ? 1 : 0;
      const totalTests = spec
        ? test_name ? 1
          : test_type === "conversation" ? convCount
          : test_type === "load_test" ? loadCount
          : convCount + loadCount
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
