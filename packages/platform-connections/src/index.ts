import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  PlatformConfigSchema,
  PlatformSummarySchema,
  type PlatformConfig,
  type PlatformConnectionSummary,
  type PlatformProvider,
  type PlatformSummary,
} from "@vent/shared";

const PLATFORM_CONNECTIONS_MASTER_KEY_ENV = "PLATFORM_CONNECTIONS_MASTER_KEY";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENVELOPE_KEY_VERSION = "v1";
const IV_BYTES = 12;

export interface EncryptedSecretsEnvelope {
  alg: typeof ENCRYPTION_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
  key_version: string;
}

export interface SplitPlatformConfigResult {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  platformSummary: PlatformSummary;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // Strict: 64 hex chars only. The previous fallback to UTF-8 32-byte
  // strings silently accepted weak keys (e.g. an accidentally-short
  // memorable phrase that happened to be 32 bytes). Generate via
  // `openssl rand -hex 32`. No base64 fallback either — one canonical
  // format avoids "did you mean hex or base64?" failure modes.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  throw new Error(
    `${PLATFORM_CONNECTIONS_MASTER_KEY_ENV} must be exactly 64 hex characters (generate with: openssl rand -hex 32)`,
  );
}

function loadMasterKey(): Buffer {
  const raw = process.env[PLATFORM_CONNECTIONS_MASTER_KEY_ENV];
  if (!raw) {
    throw new Error(`${PLATFORM_CONNECTIONS_MASTER_KEY_ENV} is required for saved platform connections`);
  }
  return normalizeMasterKey(raw);
}

function secretEntries(platform: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(platform).reduce<Array<[string, string]>>((acc, [key, value]) => {
    if (isSecretField(key) && typeof value === "string" && value.length > 0) {
      acc.push([key, value]);
    }
    return acc;
  }, []).sort(([a], [b]) => a.localeCompare(b));
}

function nonSecretEntries(platform: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(platform)
    .filter(([key, value]) => !isSecretField(key) && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
}

function requiredFieldError(field: string, provider: PlatformProvider): Error {
  return new Error(`Saved ${provider} connections require ${field}`);
}

export function isSecretField(key: string): boolean {
  return key.endsWith("_api_key") || key.endsWith("_api_secret");
}

export function assertPlatformConnectionsConfigured(): void {
  loadMasterKey();
}

export function validateResolvedPlatformConfig(platform: PlatformConfig): void {
  switch (platform.provider) {
    case "vapi":
      if (!platform.vapi_api_key) throw requiredFieldError("vapi_api_key", platform.provider);
      if (!platform.vapi_assistant_id) throw requiredFieldError("vapi_assistant_id", platform.provider);
      return;
    case "retell":
      if (!platform.retell_api_key) throw requiredFieldError("retell_api_key", platform.provider);
      if (!platform.retell_agent_id) throw requiredFieldError("retell_agent_id", platform.provider);
      return;
    case "elevenlabs":
      if (!platform.elevenlabs_api_key) throw requiredFieldError("elevenlabs_api_key", platform.provider);
      if (!platform.elevenlabs_agent_id) throw requiredFieldError("elevenlabs_agent_id", platform.provider);
      return;
    case "livekit":
      if (!platform.livekit_api_key) throw requiredFieldError("livekit_api_key", platform.provider);
      if (!platform.livekit_api_secret) throw requiredFieldError("livekit_api_secret", platform.provider);
      if (!platform.livekit_url) throw requiredFieldError("livekit_url", platform.provider);
      return;
    case "bland":
      if (!platform.bland_api_key) throw requiredFieldError("bland_api_key", platform.provider);
      if (!platform.bland_pathway_id && !platform.task && !platform.persona_id) {
        throw new Error("Saved bland connections require bland_pathway_id, persona_id, or task");
      }
      return;
  }
}

export function buildIdentityKey(platform: PlatformConfig): string {
  switch (platform.provider) {
    case "vapi":
      if (!platform.vapi_assistant_id) throw requiredFieldError("vapi_assistant_id", platform.provider);
      return `vapi:${platform.vapi_assistant_id}`;
    case "retell":
      if (!platform.retell_agent_id) throw requiredFieldError("retell_agent_id", platform.provider);
      return `retell:${platform.retell_agent_id}`;
    case "elevenlabs":
      if (!platform.elevenlabs_agent_id) throw requiredFieldError("elevenlabs_agent_id", platform.provider);
      return `elevenlabs:${platform.elevenlabs_agent_id}`;
    case "livekit":
      if (!platform.livekit_url) throw requiredFieldError("livekit_url", platform.provider);
      return `livekit:${platform.livekit_url}:${platform.livekit_agent_name ?? "auto"}`;
    case "bland":
      if (platform.bland_pathway_id) return `bland:pathway:${platform.bland_pathway_id}`;
      if (platform.persona_id) return `bland:persona:${platform.persona_id}`;
      if (platform.task) return `bland:task:${sha256(platform.task.trim())}`;
      throw new Error("Saved bland connections require bland_pathway_id, persona_id, or task");
  }
}

export function buildResourceLabel(platform: PlatformConfig): string {
  switch (platform.provider) {
    case "vapi":
      if (!platform.vapi_assistant_id) throw requiredFieldError("vapi_assistant_id", platform.provider);
      return `vapi/${platform.vapi_assistant_id}`;
    case "retell":
      if (!platform.retell_agent_id) throw requiredFieldError("retell_agent_id", platform.provider);
      return `retell/${platform.retell_agent_id}`;
    case "elevenlabs":
      if (!platform.elevenlabs_agent_id) throw requiredFieldError("elevenlabs_agent_id", platform.provider);
      return `elevenlabs/${platform.elevenlabs_agent_id}`;
    case "livekit":
      if (!platform.livekit_url) throw requiredFieldError("livekit_url", platform.provider);
      return `livekit/${platform.livekit_url}#${platform.livekit_agent_name ?? "auto"}`;
    case "bland":
      if (platform.bland_pathway_id) return `bland/${platform.bland_pathway_id}`;
      if (platform.persona_id) return `bland/persona:${platform.persona_id}`;
      if (platform.task) return `bland/task:${sha256(platform.task.trim()).slice(0, 12)}`;
      throw new Error("Saved bland connections require bland_pathway_id, persona_id, or task");
  }
}

export function buildResolvedHash(platform: PlatformConfig): string {
  return sha256(stableSerialize(platform));
}

export function splitPlatformConfig(platform: PlatformConfig): SplitPlatformConfigResult {
  validateResolvedPlatformConfig(platform);
  const platformRecord = platform as unknown as Record<string, unknown>;
  const config = Object.fromEntries(nonSecretEntries(platformRecord));
  const secrets = Object.fromEntries(secretEntries(platformRecord));
  const parsedConfig = PlatformConfigSchema.parse(config) as Record<string, unknown>;
  const platformSummary = PlatformSummarySchema.parse(parsedConfig);
  return {
    config: parsedConfig,
    secrets,
    platformSummary,
  };
}

export function mergePlatformConfig(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): PlatformConfig {
  return PlatformConfigSchema.parse({ ...config, ...secrets });
}

export function encryptSecrets(secrets: Record<string, string>): EncryptedSecretsEnvelope {
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: ENCRYPTION_ALGORITHM,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    key_version: ENVELOPE_KEY_VERSION,
  };
}

export function decryptSecrets(envelope: EncryptedSecretsEnvelope): Record<string, string> {
  if (envelope.alg !== ENCRYPTION_ALGORITHM) {
    throw new Error(`Unsupported secret envelope algorithm: ${envelope.alg}`);
  }
  const key = loadMasterKey();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
}

export function toPlatformConnectionSummary(input: {
  id: string;
  provider: string;
  version: number;
  resource_label: string;
}): PlatformConnectionSummary {
  return {
    id: input.id,
    provider: input.provider as PlatformProvider,
    version: input.version,
    resource_label: input.resource_label,
  };
}
