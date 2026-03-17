import { randomUUID, createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { schema } from "@vent/db";
import { z } from "zod";
import {
  AdapterTypeSchema,
  LoadTestSpecSchema,
  ConversationTestSpecSchema,
  PlatformConfigSchema,
  CallerAudioEffectsSchema,
} from "@vent/shared";
import type { FastifyInstance } from "fastify";

// ---- Zod schema for run submission ----

export const RunSubmitConfigSchema = z.object({
  connection: z.object({
    adapter: AdapterTypeSchema.default("websocket"),
    agent_url: z.string().optional(),
    agent_port: z.number().int().min(1).max(65535).optional(),
    start_command: z.string().optional(),
    health_endpoint: z.string().optional(),
    target_phone_number: z.string().optional(),
    caller_audio: CallerAudioEffectsSchema.optional(),
    platform: PlatformConfigSchema.optional(),
  }),
  conversation_tests: z.array(ConversationTestSpecSchema).optional(),
  load_test: LoadTestSpecSchema.optional(),
}).refine(
  (d) => (d.conversation_tests?.length ?? 0) > 0 || d.load_test != null,
  { message: "Exactly one of conversation_tests or load_test is required." }
).refine(
  (d) => !((d.conversation_tests?.length ?? 0) > 0 && d.load_test != null),
  { message: "conversation_tests and load_test cannot be used together." }
);

export const RunSubmitSchema = z.object({
  config: RunSubmitConfigSchema,
  idempotency_key: z.string().uuid().optional(),
});

export type RunSubmitInput = z.infer<typeof RunSubmitSchema>;

// ---- Helpers ----

export function hashIdempotencyKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function buildTestSpec(cfg: Record<string, unknown>) {
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
}

// ---- Core submit function ----

export interface SubmitRunParams {
  apiKeyId: string;
  userId: string;
  config: RunSubmitInput["config"];
  idempotencyKey?: string;
}

export interface SubmitRunResult {
  run_id: string;
  status: string;
  deduplicated?: boolean;
  relay_config?: {
    run_id: string;
    relay_token: string;
    api_url: string;
    agent_port: number;
    start_command: string | null;
    health_endpoint: string;
  };
}

export async function submitRun(
  app: FastifyInstance,
  params: SubmitRunParams,
): Promise<SubmitRunResult> {
  const { apiKeyId, userId, config, idempotencyKey } = params;

  const hashedIdempotencyKey = idempotencyKey
    ? hashIdempotencyKey(idempotencyKey)
    : null;

  // Idempotency check
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
      return { run_id: existing.id, status: existing.status, deduplicated: true };
    }
  }

  // Flatten connection into cfg
  const { connection, ...rest } = config;
  const cfg = { ...connection, ...rest } as Record<string, unknown>;

  const { testSpecJson, adapter, agentUrl, voiceConfig, targetPhoneNumber, conversationTests, isRemote } = buildTestSpec(cfg);

  const apiUrl = process.env["API_URL"] ?? "https://vent-api.fly.dev";

  if (isRemote) {
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

    return { run_id: runId, status: "queued" };
  }

  // Local WebSocket agent — relay mode
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

  // Do NOT enqueue here — relay runs are enqueued by /internal/runs/:id/activate
  // after the relay tunnel is connected. Enqueuing here causes duplicate job processing.

  const agentPort = (cfg.agent_port as number | undefined) ?? 3001;

  return {
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
  };
}
