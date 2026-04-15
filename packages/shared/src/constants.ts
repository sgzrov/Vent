export const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
export const DEFAULT_HEALTH_TIMEOUT_MS = 60_000; // 1 minute
export const DEFAULT_HEALTH_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_AGENT_PORT = 3001;
export const DEFAULT_API_PORT = 3000;

export const RUNNER_CALLBACK_HEADER = "x-runner-secret";

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
