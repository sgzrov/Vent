import type { FastifyReply } from "fastify";

/**
 * In-memory SSE subscriber manager for live run event streaming.
 * Maps run IDs to connected SSE clients.
 */

const subscribers = new Map<string, Set<FastifyReply>>();

/**
 * Promise-based waiters for long-polling.
 * When broadcast fires, any pending waiters for that runId are resolved.
 */
const waiters = new Map<string, Set<() => void>>();

/**
 * Register a waiter that resolves when the next broadcast fires for this runId.
 * Returns { promise, cancel } — call cancel() if you discover the wait is unnecessary
 * (e.g., the run already completed) to avoid a dangling Promise.
 */
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
      if (set.size === 0) waiters.delete(runId);
    }
  };

  let set = waiters.get(runId);
  if (!set) {
    set = new Set();
    waiters.set(runId, set);
  }
  set.add(handler);

  return { promise, cancel: () => { cleanup(); resolve(); } };
}

export function subscribe(runId: string, reply: FastifyReply): void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(reply);
}

export function unsubscribe(runId: string, reply: FastifyReply): void {
  const set = subscribers.get(runId);
  if (!set) return;
  set.delete(reply);
  if (set.size === 0) {
    subscribers.delete(runId);
  }
}

export interface RunEventPayload {
  id?: string;
  run_id: string;
  event_type: string;
  message: string;
  metadata_json?: Record<string, unknown> | null;
  created_at?: string;
}

export function broadcast(runId: string, event: RunEventPayload): void {
  // Notify SSE subscribers (dashboard)
  const sseSet = subscribers.get(runId);
  if (sseSet && sseSet.size > 0) {
    const data = JSON.stringify(event);
    for (const reply of sseSet) {
      try {
        reply.raw.write(`data: ${data}\n\n`);
      } catch {
        // Client disconnected — clean up on next unsubscribe
      }
    }
  }

  // Resolve any long-poll waiters
  const waiterSet = waiters.get(runId);
  if (waiterSet && waiterSet.size > 0) {
    for (const handler of waiterSet) handler();
  }
}
