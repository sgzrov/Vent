import { API_BASE } from "./config.js";
import { isVerbose } from "./output.js";

export interface SSEEvent {
  id?: string;
  run_id?: string;
  event_type: string;
  message?: string;
  metadata_json?: Record<string, unknown> | null;
  created_at?: string;
}

function log(msg: string): void {
  if (!isVerbose()) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[vent:sse ${ts}] ${msg}\n`;
  process.stderr.write(line);
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
  log(`connecting to ${url}`);

  // Use caller's signal only — no fixed timeout here.
  // The Bash tool's timeout (300s) provides the outer deadline.
  // A fixed 30s timeout kills the stream mid-test.
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });

  log(`response: status=${res.status} content-type=${res.headers.get("content-type")}`);

  if (!res.ok) {
    const body = await res.text();
    log(`error body: ${body}`);
    throw new Error(`SSE stream failed (${res.status}): ${body}`);
  }

  if (!res.body) {
    throw new Error("SSE stream returned no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  let eventCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        log(`stream done after ${chunkCount} chunks, ${eventCount} events`);
        break;
      }

      chunkCount++;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      if (chunkCount <= 3 || chunkCount % 10 === 0) {
        log(`chunk #${chunkCount} (${chunk.length} bytes) buffer=${buffer.length} bytes`);
      }

      const lines = buffer.split("\n");
      buffer = lines.pop()!; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const raw = line.slice(6);
          try {
            const event = JSON.parse(raw) as SSEEvent;
            eventCount++;
            log(`parsed event #${eventCount}: type=${event.event_type}`);
            yield event;

            if (event.event_type === "run_complete") {
              log("run_complete received — closing stream");
              return;
            }
          } catch {
            log(`malformed JSON: ${raw.slice(0, 200)}`);
          }
        } else if (line.startsWith(": ")) {
          // heartbeat comment — just log occasionally
          if (chunkCount <= 3) {
            log(`heartbeat: "${line}"`);
          }
        }
        // Ignore empty lines
      }
    }
  } finally {
    reader.releaseLock();
    log("reader released");
  }
}
