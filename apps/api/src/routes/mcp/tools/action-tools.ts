import type { FastifyInstance } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@voiceci/db";
import { createStorageClient } from "@voiceci/artifacts";
import { z } from "zod";
import {
  AdapterTypeSchema,
  LoadPatternSchema,
} from "@voiceci/shared";
import { runLoadTestInProcess } from "../../../services/test-runner.js";

export function registerActionTools(
  server: McpServer,
  app: FastifyInstance,
  apiKeyId: string,
  userId: string,
) {
  // --- Tool: voiceci_run_suite ---
  server.registerTool("voiceci_run_suite", {
    title: "Run Test Suite",
    description: "Run a test suite against a voice agent. Requires voiceci.json in the project root.\n\nRead voiceci.json, then pass its parsed JSON as the `config` parameter. For already-deployed agents (SIP, WebRTC, platform adapters, or agent_url), this queues immediately — no bash step. For bundled websocket agents, a short upload command is returned.\n\nThen poll voiceci_get_status with the run_id.",
    inputSchema: {
      config: z
        .any()
        .describe("Parsed contents of voiceci.json. Read the file, then pass the parsed JSON object here."),
      project_root: z
        .string()
        .optional()
        .describe("Absolute path to agent project root containing voiceci.json. Defaults to current working directory."),
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
    // Idempotency check — return existing run if key matches
    if (idempotency_key) {
      const [existing] = await app.db
        .select({ id: schema.runs.id, status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.idempotency_key, idempotency_key))
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
          text: "Error: config parameter is required. Read voiceci.json from the project root and pass its parsed JSON contents as the config parameter.",
        }],
        isError: true,
      };
    }

    const cfg = (typeof config === "string" ? JSON.parse(config) : config) as Record<string, unknown>;
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
          idempotency_key: idempotency_key ?? null,
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
            message: "Run queued. Poll voiceci_get_status with the run_id.",
          }, null, 2),
        }],
      };
    }

    // Bundled agent — store config in DB, return bash for tar+upload+hashes
    const storage = createStorageClient();
    const bundleKey = `bundles/${randomUUID()}.tar.gz`;
    const uploadUrl = await storage.presignUpload(bundleKey);

    const [run] = await app.db
      .insert(schema.runs)
      .values({
        api_key_id: apiKeyId,
        user_id: userId,
        source_type: "bundle",
        bundle_key: bundleKey,
        bundle_hash: null,
        status: "queued",
        test_spec_json: testSpecJson,
        idempotency_key: idempotency_key ?? null,
      })
      .returning();

    const runId = run!.id;

    const root = project_root ?? ".";
    const tarTarget = project_root ? `-C "${project_root}" .` : ".";
    const excludes = "--exclude=node_modules --exclude=.git --exclude=dist --exclude=.next --exclude=.turbo --exclude=coverage --exclude=voiceci.json";
    const lockfileHashCmd = `(cat "${root}/package-lock.json" "${root}/yarn.lock" "${root}/pnpm-lock.yaml" 2>/dev/null || true) | shasum -a 256 | awk '{print $1}'`;
    const activateUrl = `${apiUrl}/internal/runs/${runId}/activate`;

    const uploadCommand = [
      `tar czf /tmp/vci-bundle.tar.gz ${excludes} ${tarTarget}`,
      `BUNDLE_HASH=$(shasum -a 256 /tmp/vci-bundle.tar.gz | awk '{print $1}')`,
      `LOCKFILE_HASH=$(${lockfileHashCmd})`,
      `curl -sf -X PUT -T /tmp/vci-bundle.tar.gz -H 'Content-Type: application/gzip' '${uploadUrl}'`,
      `curl -sf -X POST '${activateUrl}' -H 'Content-Type: application/json' -d "{\\"bundle_hash\\":\\"$BUNDLE_HASH\\",\\"lockfile_hash\\":\\"$LOCKFILE_HASH\\"}"`,
      `echo "Upload complete. Run activated."`,
    ].join(" && ");

    return {
      content: [{
        type: "text" as const,
        text: `ACTION REQUIRED: Run this command in the project root to upload the bundle and start the test. The run will NOT proceed until you execute this command.\n\n${uploadCommand}\n\nAfter the command prints "Upload complete. Run activated.", poll voiceci_get_status with run_id: ${runId}`,
      }],
    };
  });

  // --- Tool: voiceci_load_test ---
  server.registerTool("voiceci_load_test", {
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
    runLoadTestInProcess({
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
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "started",
            pattern,
            target_concurrency,
            total_duration_s,
            message: "Load test running. Results will be pushed via SSE as timeline snapshots every second, with a final summary when complete.",
          }, null, 2),
        },
      ],
    };
  });

  // --- Tool: voiceci_get_status ---
  server.registerTool("voiceci_get_status", {
    title: "Get Run Status",
    description: "Get the current status and results of a test run by ID. Poll this to track progress — it returns partial results as individual tests complete, so you can reason about early failures while other tests are still running. Once the run finishes, returns the full aggregate summary and all results.",
    inputSchema: {
      run_id: z.string().uuid().describe("The run ID returned by voiceci_run_suite."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ run_id }) => {
    const [run] = await app.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run_id))
      .limit(1);

    if (!run) {
      return {
        content: [{ type: "text" as const, text: `Error: Run ${run_id} not found.` }],
        isError: true,
      };
    }

    // Still in progress — return partial results if available
    if (run.status === "queued" || run.status === "running") {
      const partialResults = await app.db
        .select()
        .from(schema.scenarioResults)
        .where(eq(schema.scenarioResults.run_id, run_id));

      // Derive total test count from stored config
      const spec = run.test_spec_json as { audio_tests?: unknown[]; conversation_tests?: unknown[] } | null;
      const totalTests = spec
        ? (spec.audio_tests?.length ?? 0) + (spec.conversation_tests?.length ?? 0)
        : undefined;

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

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          run_id: run.id,
          status: run.status,
          aggregate: run.aggregate_json,
          audio_results: audioResults,
          conversation_results: conversationResults,
          error_text: run.error_text ?? null,
          duration_ms: run.duration_ms,
          started_at: run.started_at,
          finished_at: run.finished_at,
        }, null, 2),
      }],
    };
  });
}
