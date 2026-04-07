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
  process.stdout.write(line);
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

/**
 * Async generator over SSE events from GET /runs/:id/stream.
 * Yields parsed event objects. Completes when the connection closes
 * or a run_complete event is received.
 *
 * Automatically reconnects if the stream drops before run_complete,
 * deduplicating events by ID so callers never see duplicates.
 */
export async function* streamRunEvents(
  runId: string,
  apiKey: string,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const url = `${API_BASE}/runs/${runId}/stream`;
  const seenIds = new Set<string>();
  let retries = 0;

  while (retries <= MAX_RETRIES) {
    if (retries > 0) {
      log(`reconnecting (attempt ${retries}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms…`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    log(`connecting to ${url}`);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      log(`fetch error: ${(err as Error).message}`);
      retries++;
      continue;
    }

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
    let gotRunComplete = false;
    let streamError: Error | null = null;

    try {
      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          streamError = err as Error;
          log(`read error: ${streamError.message}`);
          break;
        }

        const { done, value } = readResult;
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

              // Deduplicate on reconnect — server replays all events from DB
              if (event.id && seenIds.has(event.id)) {
                log(`skipping duplicate event ${event.id}`);
                continue;
              }
              if (event.id) seenIds.add(event.id);

              log(`parsed event #${eventCount}: type=${event.event_type}`);
              yield event;

              if (event.event_type === "run_complete") {
                log("run_complete received — closing stream");
                gotRunComplete = true;
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

    // If we got run_complete, we're done (return already exited above, but just in case)
    if (gotRunComplete) return;

    // Stream ended without run_complete — retry
    retries++;
    if (retries <= MAX_RETRIES) {
      log(`stream ended without run_complete — will retry (${retries}/${MAX_RETRIES})`);
    }
  }

  // Exhausted retries without run_complete — yield a synthetic error event
  // so callers know the stream failed rather than silently getting nothing
  log(`exhausted ${MAX_RETRIES} retries without run_complete`);
  yield {
    event_type: "error",
    message: `Stream lost after ${MAX_RETRIES} reconnect attempts without receiving run_complete`,
  } as SSEEvent;
}
