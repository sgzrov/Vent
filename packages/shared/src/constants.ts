export const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
export const DEFAULT_HEALTH_TIMEOUT_MS = 60_000; // 1 minute
export const DEFAULT_HEALTH_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_AGENT_PORT = 3001;
export const DEFAULT_API_PORT = 3000;

// Legacy plaintext-secret header. Still used for relay WebSocket and relay-ready
// GET (no body to sign). New POST callbacks use the HMAC headers below.
export const RUNNER_CALLBACK_HEADER = "x-runner-secret";

// HMAC-signed callback headers (for POST /internal/* routes).
// Signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`), base64url.
// Timestamp is unix milliseconds; reject if drift > RUNNER_CALLBACK_MAX_SKEW_MS.
export const RUNNER_CALLBACK_SIGNATURE_HEADER = "x-vent-signature";
export const RUNNER_CALLBACK_TIMESTAMP_HEADER = "x-vent-timestamp";
export const RUNNER_CALLBACK_MAX_SKEW_MS = 5 * 60_000;

export const RUN_QUEUE_PREFIX = "voice-ci-runs-";
export const RUN_QUEUE_REGISTRY_SET = "vent:active-queues";
export const RUN_QUEUE_NEW_CHANNEL = "vent:new-queue";
export const RUN_QUEUE_ACTIVITY_CHANNEL = "vent:queue-activity";
export const RUN_QUEUE_ACTIVITY_KEY_PREFIX = "vent:queue-activity:";
export const RUN_QUEUE_ACTIVITY_TTL_SECONDS = 900;

export const WORKER_PRESENCE_SET = "vent:worker-machines";
export const WORKER_PRESENCE_KEY_PREFIX = "vent:worker-presence:";
export const WORKER_PRESENCE_TTL_SECONDS = 20;

export const FLEET_ACTIVE_RUNS_KEY = "vent:active-runs";
