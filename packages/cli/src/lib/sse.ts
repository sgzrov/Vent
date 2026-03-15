import { API_BASE } from "./config.js";

export interface SSEEvent {
  event_type: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Async generator over SSE events from GET /runs/:id/stream.
 * Yields parsed event objects. Completes when the connection closes
 * or a run_complete event is received.
 */
export async function* streamRunEvents(
  runId: string,
  apiKey: string,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const url = `${API_BASE}/runs/${runId}/stream`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });

  if (!res.ok) {
    throw new Error(`SSE stream failed (${res.status}): ${await res.text()}`);
  }

  if (!res.body) {
    throw new Error("SSE stream returned no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6)) as SSEEvent;
            yield event;

            if (event.event_type === "run_complete") {
              return;
            }
          } catch {
            // Skip malformed JSON
          }
        }
        // Ignore comments (: heartbeat) and empty lines
      }
    }
  } finally {
    reader.releaseLock();
  }
}
