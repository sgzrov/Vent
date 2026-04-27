import { createHmac, timingSafeEqual } from "node:crypto";
import {
  RUNNER_CALLBACK_MAX_SKEW_MS,
  RUNNER_CALLBACK_SIGNATURE_HEADER,
  RUNNER_CALLBACK_TIMESTAMP_HEADER,
} from "./constants.js";

export interface CallbackHeaders {
  [RUNNER_CALLBACK_SIGNATURE_HEADER]: string;
  [RUNNER_CALLBACK_TIMESTAMP_HEADER]: string;
}

function computeSignature(timestamp: string, rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("base64url");
}

export function signCallback(rawBody: string, secret: string): CallbackHeaders {
  const timestamp = String(Date.now());
  const signature = computeSignature(timestamp, rawBody, secret);
  return {
    [RUNNER_CALLBACK_SIGNATURE_HEADER]: signature,
    [RUNNER_CALLBACK_TIMESTAMP_HEADER]: timestamp,
  };
}

export type VerifyCallbackResult =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "missing_timestamp" | "stale_timestamp" | "bad_signature" };

export function verifyCallback(
  rawBody: string,
  secret: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  nowMs: number = Date.now(),
): VerifyCallbackResult {
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  if (!timestampHeader) return { ok: false, reason: "missing_timestamp" };

  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "missing_timestamp" };
  if (Math.abs(nowMs - ts) > RUNNER_CALLBACK_MAX_SKEW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = computeSignature(timestampHeader, rawBody, secret);
  const provided = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}
