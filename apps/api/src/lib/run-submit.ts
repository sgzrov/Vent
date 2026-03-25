import { randomUUID, createHash } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
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

// ---- Usage limit error ----

export class UsageLimitError extends Error {
  public limit: number;
  public used: number;

  constructor(limit: number, used: number) {
    super(
      `Free tier limit reached (${used}/${limit} runs). Run \`npx vent-hq login\` to upgrade.`,
    );
    this.name = "UsageLimitError";
    this.limit = limit;
    this.used = used;
  }
}

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
  red_team_tests: z.array(ConversationTestSpecSchema).optional(),
  load_test: LoadTestSpecSchema.optional(),
}).refine(
  (d) => {
    const hasConv = (d.conversation_tests?.length ?? 0) > 0;
    const hasRedTeam = (d.red_team_tests?.length ?? 0) > 0;
    const hasLoad = d.load_test != null;
    return hasConv || hasRedTeam || hasLoad;
  },
  { message: "Exactly one of conversation_tests, red_team_tests, or load_test is required." }
).refine(
  (d) => {
    const hasConv = (d.conversation_tests?.length ?? 0) > 0;
    const hasRedTeam = (d.red_team_tests?.length ?? 0) > 0;
    const hasLoad = d.load_test != null;
    const count = [hasConv, hasRedTeam, hasLoad].filter(Boolean).length;
    return count === 1;
  },
  { message: "Only one of conversation_tests, red_team_tests, or load_test can be used per run." }
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

  // Merge root-level caller_audio as default onto conversation/red_team tests
  const callerAudio = cfg.caller_audio as Record<string, unknown> | undefined;
  let conversationTests = cfg.conversation_tests as Record<string, unknown>[] | null | undefined;
  let redTeamTests = cfg.red_team_tests as Record<string, unknown>[] | null | undefined;
  if (callerAudio && Array.isArray(conversationTests)) {
    conversationTests = conversationTests.map((test) => {
      if (test.caller_audio === undefined) {
        return { ...test, caller_audio: callerAudio };
      }
      return test;
    });
  }
  if (callerAudio && Array.isArray(redTeamTests)) {
    redTeamTests = redTeamTests.map((test) => {
      if (test.caller_audio === undefined) {
        return { ...test, caller_audio: callerAudio };
      }
      return test;
    });
  }

  // Strip api_key from platform before persisting to DB (secrets stay in job queue only)
  const platformForDb = cfg.platform
    ? { ...(cfg.platform as Record<string, unknown>), api_key: undefined }
    : null;

  return {
    testSpecJson: {
      conversation_tests: conversationTests ?? null,
      red_team_tests: redTeamTests ?? null,
      load_test: cfg.load_test ?? null,
      adapter,
      voice_config: voiceConfig,
      start_command: cfg.start_command ?? null,
      health_endpoint: cfg.health_endpoint ?? null,
      agent_url: agentUrl ?? null,
      target_phone_number: targetPhoneNumber ?? null,
      platform: platformForDb,
    },
    adapter,
    agentUrl,
    voiceConfig,
    targetPhoneNumber,
    conversationTests: conversationTests ?? null,
    redTeamTests: redTeamTests ?? null,
    isRemote: ["vapi", "retell", "elevenlabs", "bland", "livekit", "webrtc"].includes(adapter)
      || adapter === "sip" || !!agentUrl,
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

  // Usage limit check for anonymous API keys
  const [apiKeyRow] = await app.db
    .select({ run_limit: schema.apiKeys.run_limit })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.id, apiKeyId))
    .limit(1);

  if (apiKeyRow?.run_limit != null) {
    const [{ count }] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(eq(schema.runs.user_id, userId));

    if (count >= apiKeyRow.run_limit) {
      throw new UsageLimitError(apiKeyRow.run_limit, count);
    }
  }

  // Flatten connection into cfg
  const { connection, ...rest } = config;
  const cfg = { ...connection, ...rest } as Record<string, unknown>;

  const { testSpecJson, adapter, agentUrl, voiceConfig, targetPhoneNumber, conversationTests, redTeamTests, isRemote } = buildTestSpec(cfg);

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
        red_team_tests: redTeamTests ?? null,
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
