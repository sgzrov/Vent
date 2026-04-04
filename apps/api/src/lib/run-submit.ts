import { createHash } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { schema } from "@vent/db";
import { z } from "zod";
import {
  AdapterTypeSchema,
  ConversationCallSpecSchema,
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
    caller_audio: CallerAudioEffectsSchema.optional(),
    platform_connection_id: z.string().uuid().optional(),
    platform: z.never().optional(),
  }),
  call: ConversationCallSpecSchema,
}).superRefine((d, ctx) => {
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
  agent_session_id: z.string().uuid().optional(),
});

export type RunSubmitInput = z.infer<typeof RunSubmitSchema>;

// ---- Helpers ----

export function hashIdempotencyKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function buildCallSpec(
  cfg: Record<string, unknown>,
  platformMeta?: {
    platform_connection_id: string | null;
    platform_connection: PlatformConnectionSummary | null;
    platform: PlatformSummary | null;
  },
) {
  const adapter = (cfg.adapter as string) ?? "websocket";
  const agentUrl = cfg.agent_url as string | undefined;
  const voiceConfig = { adapter };

  // Merge root-level caller_audio as default onto the call spec
  const callerAudio = cfg.caller_audio as Record<string, unknown> | undefined;
  let call = cfg.call as Record<string, unknown> | null | undefined;
  if (callerAudio && call && call.caller_audio === undefined) {
    call = { ...call, caller_audio: callerAudio };
  }

  return {
    callSpecJson: {
      call: call ?? null,
      adapter,
      voice_config: voiceConfig,
      start_command: cfg.start_command ?? null,
      health_endpoint: cfg.health_endpoint ?? null,
      agent_url: agentUrl ?? null,
      platform_connection_id: platformMeta?.platform_connection_id ?? null,
      platform_connection: platformMeta?.platform_connection ?? null,
      platform: platformMeta?.platform ?? null,
    },
    adapter,
    agentUrl,
    voiceConfig,

    call: call ?? null,
    isRemote: PLATFORM_ADAPTERS.has(adapter) || !!agentUrl,
  };
}

// ---- Core submit function ----

export interface SubmitRunParams {
  accessTokenId: string;
  userId: string;
  config: RunSubmitInput["config"];
  idempotencyKey?: string;
  agentSessionId?: string;
}

export interface SubmitRunResult {
  run_id: string;
  status: string;
  deduplicated?: boolean;
}

export async function submitRun(
  app: FastifyInstance,
  params: SubmitRunParams,
): Promise<SubmitRunResult> {
  const { accessTokenId, userId, config, idempotencyKey, agentSessionId } = params;

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
    callSpecJson,
    adapter: resolvedAdapter,
    agentUrl,
    voiceConfig,

    call,
    isRemote,
  } = buildCallSpec(cfg, {
    platform_connection_id: platformConnectionId,
    platform_connection: platformConnectionSummary,
    platform: platformSummary,
  });

  if (isRemote) {
    const [run] = await app.db
      .insert(schema.runs)
      .values({
        access_token_id: accessTokenId,
        user_id: userId,
        source_type: "remote",
        status: "queued",
        test_spec_json: callSpecJson,
        idempotency_key: hashedIdempotencyKey,
      })
      .returning();

    const runId = run!.id;

    await app.getRunQueue(userId).add("execute-run", {
      run_id: runId,
      adapter: resolvedAdapter,
      call_spec: {
        call: call ?? null,
      },
      voice_config: voiceConfig,
      start_command: cfg.start_command as string | undefined,
      health_endpoint: cfg.health_endpoint as string | undefined,
      agent_url: agentUrl,
      platform_connection_id: platformConnectionId,
    }, { jobId: runId });

    return { run_id: runId, status: "queued" };
  }

  // Local agent via agent session — session must already be active
  if (!agentSessionId) {
    throw new SubmitRunConfigError(
      "Non-remote runs require an agent_session_id. Start an agent session first with `npx vent-hq agent start`.",
    );
  }

  // Verify the agent session exists, belongs to the user, and is active
  const [agentSession] = await app.db
    .select({ id: schema.agentSessions.id, status: schema.agentSessions.status })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.id, agentSessionId),
        eq(schema.agentSessions.user_id, userId),
      ),
    )
    .limit(1);

  if (!agentSession) {
    throw new SubmitRunConfigError("Agent session not found", 404);
  }
  if (agentSession.status !== "active") {
    throw new SubmitRunConfigError(
      `Agent session is "${agentSession.status}" — it must be "active". Ensure the relay tunnel is connected.`,
    );
  }

  const relayReady = await app.redis.get(`vent:relay-session:${agentSessionId}`);
  if (!relayReady) {
    throw new SubmitRunConfigError(
      "Agent session relay is no longer connected. Start a new session with `npx vent-hq agent start`.",
    );
  }

  const [run] = await app.db
    .insert(schema.runs)
    .values({
      access_token_id: accessTokenId,
      user_id: userId,
      source_type: "session",
      status: "queued",
      test_spec_json: callSpecJson,
      idempotency_key: hashedIdempotencyKey,
      agent_session_id: agentSessionId,
    })
    .returning();

  const runId = run!.id;

  // Enqueue immediately — session relay is already connected
  await app.getRunQueue(userId).add("execute-run", {
    run_id: runId,
    adapter: resolvedAdapter,
    call_spec: {
      call: call ?? null,
    },
    voice_config: voiceConfig,
    start_command: cfg.start_command as string | undefined,
    health_endpoint: cfg.health_endpoint as string | undefined,
    agent_url: agentUrl,
    agent_session_id: agentSessionId,
    platform_connection_id: platformConnectionId,
  }, { jobId: runId });

  return { run_id: runId, status: "queued" };
}
