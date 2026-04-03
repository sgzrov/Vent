import { createHmac, timingSafeEqual } from "node:crypto";
import { S3Storage } from "./s3.js";
import type { StorageConfig } from "./s3.js";

export type { StorageConfig } from "./s3.js";
export { S3Storage } from "./s3.js";

interface ArtifactTokenPayload {
  v: 1;
  k: string;
}

function signToken(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createArtifactToken(key: string, secret: string): string {
  const payload: ArtifactTokenPayload = { v: 1, k: key };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${signToken(encodedPayload, secret)}`;
}

export function verifyArtifactToken(token: string, secret: string): string | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = signToken(encodedPayload, secret);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<ArtifactTokenPayload>;
    if (payload.v !== 1 || typeof payload.k !== "string" || payload.k.length === 0) {
      return null;
    }
    return payload.k;
  } catch {
    return null;
  }
}

export function buildArtifactUrl(baseUrl: string, token: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/recordings/${encodeURIComponent(token)}`;
}

export function createStorageClient(config?: Partial<StorageConfig>): S3Storage {
  const fullConfig: StorageConfig = {
    endpoint: config?.endpoint ?? process.env["S3_ENDPOINT"] ?? "",
    bucket: config?.bucket ?? process.env["S3_BUCKET"] ?? "vent-bundles",
    accessKeyId: config?.accessKeyId ?? process.env["S3_ACCESS_KEY_ID"] ?? "",
    secretAccessKey:
      config?.secretAccessKey ?? process.env["S3_SECRET_ACCESS_KEY"] ?? "",
    region: config?.region ?? process.env["S3_REGION"] ?? "auto",
  };

  if (!fullConfig.endpoint) {
    throw new Error("S3_ENDPOINT is required");
  }

  return new S3Storage(fullConfig);
}
