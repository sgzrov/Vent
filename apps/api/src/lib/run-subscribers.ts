import type { FastifyReply } from "fastify";
import IORedis from "ioredis";

/**
 * Redis-backed SSE subscriber manager.
 *
 * broadcast() publishes to Redis pub/sub. Each API instance subscribes
 * to channels for runs that have local SSE/long-poll clients, then
 * delivers events to those clients. This works across multiple API instances.
 */

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";

// Dedicated connections — subscriber mode locks the client
const redisPub = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const redisSub = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const CHANNEL_PREFIX = "vent:run-events:";

// --- Local state (per-instance) ---

const subscribers = new Map<string, Set<FastifyReply>>();
const waiters = new Map<string, Set<() => void>>();
const subscribedChannels = new Set<string>();

// --- Redis subscriber listener ---

redisSub.on("message", (channel: string, message: string) => {
  if (!channel.startsWith(CHANNEL_PREFIX)) return;

  const runId = channel.slice(CHANNEL_PREFIX.length);
  let event: RunEventPayload;
  try {
    event = JSON.parse(message);
  } catch {
    return;
  }

  // Deliver to local SSE connections
  const sseSet = subscribers.get(runId);
  if (sseSet && sseSet.size > 0) {
    const data = JSON.stringify(event);
    for (const reply of sseSet) {
      try {
        reply.raw.write(`data: ${data}\n\n`);
      } catch {
        // Client disconnected — cleaned up via unsubscribe
      }
    }
  }

  // Resolve local long-poll waiters
  const waiterSet = waiters.get(runId);
  if (waiterSet && waiterSet.size > 0) {
    for (const handler of waiterSet) handler();
  }
});

// --- Public API ---

export interface RunEventPayload {
  id?: string;
  run_id: string;
  event_type: string;
  message: string;
  metadata_json?: Record<string, unknown> | null;
  created_at?: string;
}

function ensureSubscribed(runId: string): void {
  const channel = `${CHANNEL_PREFIX}${runId}`;
  if (!subscribedChannels.has(channel)) {
    subscribedChannels.add(channel);
    void redisSub.subscribe(channel);
  }
}

function maybeUnsubscribe(runId: string): void {
  const channel = `${CHANNEL_PREFIX}${runId}`;
  if (subscribedChannels.has(channel)) {
    subscribedChannels.delete(channel);
    void redisSub.unsubscribe(channel);
  }
}

export function subscribe(runId: string, reply: FastifyReply): void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(reply);
  ensureSubscribed(runId);
}

export function unsubscribe(runId: string, reply: FastifyReply): void {
  const set = subscribers.get(runId);
  if (!set) return;
  set.delete(reply);
  if (set.size === 0) {
    subscribers.delete(runId);
    // Only unsubscribe from Redis if no waiters either
    if (!waiters.has(runId)) {
      maybeUnsubscribe(runId);
    }
  }
}

export function waitForRunEvent(runId: string): { promise: Promise<void>; cancel: () => void } {
  let resolve: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });

  const handler = () => {
    cleanup();
    resolve();
  };

  const cleanup = () => {
    const set = waiters.get(runId);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        waiters.delete(runId);
        // Only unsubscribe from Redis if no SSE subscribers either
        if (!subscribers.has(runId)) {
          maybeUnsubscribe(runId);
        }
      }
    }
  };

  let set = waiters.get(runId);
  if (!set) {
    set = new Set();
    waiters.set(runId, set);
  }
  set.add(handler);
  ensureSubscribed(runId);

  return { promise, cancel: () => { cleanup(); resolve(); } };
}

/**
 * Publish event to ALL API instances via Redis pub/sub.
 * Each instance's redisSub listener delivers to its local SSE clients.
 */
export function broadcast(runId: string, event: RunEventPayload): void {
  const channel = `${CHANNEL_PREFIX}${runId}`;
  void redisPub.publish(channel, JSON.stringify(event));
}

/**
 * Clean up Redis connections on server shutdown.
 */
export async function shutdownSubscribers(): Promise<void> {
  redisSub.disconnect();
  redisPub.disconnect();
}
