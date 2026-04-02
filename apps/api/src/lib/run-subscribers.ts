import IORedis from "ioredis";

/**
 * Redis pub/sub for broadcasting run events across API instances.
 */

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";

const redisPub = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const CHANNEL_PREFIX = "vent:run-events:";

export interface RunEventPayload {
  id?: string;
  run_id: string;
  event_type: string;
  message: string;
  metadata_json?: Record<string, unknown> | null;
  created_at?: string;
}

/**
 * Publish event to ALL API instances via Redis pub/sub.
 */
export function broadcast(runId: string, event: RunEventPayload): void {
  const channel = `${CHANNEL_PREFIX}${runId}`;
  void redisPub.publish(channel, JSON.stringify(event));
}

/**
 * Clean up Redis connections on server shutdown.
 */
export async function shutdownSubscribers(): Promise<void> {
  redisPub.disconnect();
}
