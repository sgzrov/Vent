import { randomUUID, createHash } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { schema } from "@vent/db";
import { z } from "zod";
import {
  AdapterTypeSchema,
  ConversationTestSpecSchema,
  CallerAudioEffectsSchema,
  PlatformSummarySchema,
  type PlatformConnectionSummary,
  type PlatformSummary,
} from "@vent/shared";
import type { FastifyInstance } from "fastify";

const PLATFORM_ADAPTERS = new Set(["livekit", "vapi", "retell", "elevenlabs", "bland"]);

// ---- Usage limit error ----

export class UsageLimitError extends Error {
  public limit: number;
  public used: number;

  constructor(limit: number, used: number) {
    super(
      `To prevent abuse, unverified accounts are limited to ${limit} runs. Sign in to verify your account for unlimited access.`,
    );
    this.name = "UsageLimitError";
    this.limit = limit;
    this.used = used;
  }
}

export class SubmitRunConfigError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "SubmitRunConfigError";
    this.statusCode = statusCode;
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
    platform_connection_id: z.string().uuid().optional(),
    platform: z.never().optional(),
  }),
  conversation_tests: z.array(ConversationTestSpecSchema).optional(),
  red_team_tests: z.array(ConversationTestSpecSchema).optional(),
}).refine(
  (d) => {
    const hasConv = (d.conversation_tests?.length ?? 0) > 0;
    const hasRedTeam = (d.red_team_tests?.length ?? 0) > 0;
    return hasConv || hasRedTeam;
  },
  { message: "Exactly one of conversation_tests or red_team_tests is required." }
).refine(
  (d) => {
    const hasConv = (d.conversation_tests?.length ?? 0) > 0;
    const hasRedTeam = (d.red_team_tests?.length ?? 0) > 0;
    return !(hasConv && hasRedTeam);
  },
  { message: "Only one of conversation_tests or red_team_tests can be used per run." }
).superRefine((d, ctx) => {
  const adapter = d.connection.adapter;
  const platformConnectionId = d.connection.platform_connection_id;
  const requiresSavedConnection = PLATFORM_ADAPTERS.has(adapter);

  if (requiresSavedConnection && !platformConnectionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["connection", "platform_connection_id"],
      message: `${adapter} runs require platform_connection_id`,
    });
  }

  if (!requiresSavedConnection && platformConnectionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["connection", "platform_connection_id"],
      message: `${adapter} runs cannot include platform_connection_id`,
    });
  }
});

export const RunSubmitSchema = z.object({
  config: RunSubmitConfigSchema,
  idempotency_key: z.string().uuid().optional(),
});

export type RunSubmitInput = z.infer<typeof RunSubmitSchema>;

// ---- Helpers ----

export function hashIdempotencyKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function buildTestSpec(
  cfg: Record<string, unknown>,
  platformMeta?: {
    platform_connection_id: string | null;
    platform_connection: PlatformConnectionSummary | null;
    platform: PlatformSummary | null;
  },
) {
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

  return {
    testSpecJson: {
      conversation_tests: conversationTests ?? null,
      red_team_tests: redTeamTests ?? null,
      adapter,
      voice_config: voiceConfig,
      start_command: cfg.start_command ?? null,
      health_endpoint: cfg.health_endpoint ?? null,
      agent_url: agentUrl ?? null,
      target_phone_number: targetPhoneNumber ?? null,
      platform_connection_id: platformMeta?.platform_connection_id ?? null,
      platform_connection: platformMeta?.platform_connection ?? null,
      platform: platformMeta?.platform ?? null,
    },
    adapter,
    agentUrl,
    voiceConfig,
    targetPhoneNumber,
    conversationTests: conversationTests ?? null,
    redTeamTests: redTeamTests ?? null,
    isRemote: PLATFORM_ADAPTERS.has(adapter) || !!agentUrl,
  };
}

// ---- Core submit function ----

export interface SubmitRunParams {
  accessTokenId: string;
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
  const { accessTokenId, userId, config, idempotencyKey } = params;

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

  // Usage limit check for anonymous access tokens
  const [accessTokenRow] = await app.db
    .select({ run_limit: schema.accessTokens.run_limit })
    .from(schema.accessTokens)
    .where(eq(schema.accessTokens.id, accessTokenId))
    .limit(1);

  if (accessTokenRow?.run_limit != null) {
    const [{ count }] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(eq(schema.runs.user_id, userId));

    if (count >= accessTokenRow.run_limit) {
      throw new UsageLimitError(accessTokenRow.run_limit, count);
    }
  }

  const { connection, ...rest } = config;
  const cfg = { ...connection, ...rest } as Record<string, unknown>;

  const platformConnectionId = connection.platform_connection_id ?? null;
  const adapter = connection.adapter;
  const requiresSavedConnection = PLATFORM_ADAPTERS.has(adapter);

  let platformConnectionSummary: PlatformConnectionSummary | null = null;
  let platformSummary: PlatformSummary | null = null;

  if (requiresSavedConnection) {
    if (!platformConnectionId) {
      throw new SubmitRunConfigError(`${adapter} runs require platform_connection_id`);
    }

    const [savedConnection] = await app.db
      .select({
        id: schema.platformConnections.id,
        provider: schema.platformConnections.provider,
        resource_label: schema.platformConnections.resource_label,
        version: schema.platformConnections.version,
        config_json: schema.platformConnections.config_json,
      })
      .from(schema.platformConnections)
      .where(
        and(
          eq(schema.platformConnections.id, platformConnectionId),
          eq(schema.platformConnections.user_id, userId),
        ),
      )
      .limit(1);

    if (!savedConnection) {
      throw new SubmitRunConfigError("Platform connection not found", 404);
    }
    if (savedConnection.provider !== adapter) {
      throw new SubmitRunConfigError(
        `Adapter ${adapter} does not match saved connection provider ${savedConnection.provider}`,
      );
    }

    platformConnectionSummary = {
      id: savedConnection.id,
      provider: savedConnection.provider as PlatformConnectionSummary["provider"],
      version: savedConnection.version,
      resource_label: savedConnection.resource_label,
    };
    platformSummary = PlatformSummarySchema.parse(savedConnection.config_json) as PlatformSummary;
  } else if (platformConnectionId) {
    throw new SubmitRunConfigError(`${adapter} runs cannot include platform_connection_id`);
  }

  delete cfg.platform_connection_id;
  delete cfg.platform;

  const {
    testSpecJson,
    adapter: resolvedAdapter,
    agentUrl,
    voiceConfig,
    targetPhoneNumber,
    conversationTests,
    redTeamTests,
    isRemote,
  } = buildTestSpec(cfg, {
    platform_connection_id: platformConnectionId,
    platform_connection: platformConnectionSummary,
    platform: platformSummary,
  });

  const apiUrl = process.env["API_URL"] ?? "https://vent-api.fly.dev";

  if (isRemote) {
    const [run] = await app.db
      .insert(schema.runs)
      .values({
        access_token_id: accessTokenId,
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
      adapter: resolvedAdapter,
      test_spec: {
        conversation_tests: conversationTests ?? null,
        red_team_tests: redTeamTests ?? null,
      },
      target_phone_number: targetPhoneNumber,
      voice_config: voiceConfig,
      start_command: cfg.start_command as string | undefined,
      health_endpoint: cfg.health_endpoint as string | undefined,
      agent_url: agentUrl,
      platform_connection_id: platformConnectionId,
    }, { jobId: runId });

    return { run_id: runId, status: "queued" };
  }

  // Local WebSocket agent — relay mode
  const relayToken = randomUUID();
  const startCommand = cfg.start_command as string | undefined;

  const [run] = await app.db
    .insert(schema.runs)
    .values({
      access_token_id: accessTokenId,
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
