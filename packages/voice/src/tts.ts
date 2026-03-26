/**
 * Deepgram Aura-2 TTS — converts text to PCM 16-bit 24kHz mono audio.
 *
 * Uses WebSocket streaming API (speak.live) instead of REST to avoid the
 * 15-concurrent-request rate limit. WebSocket allows 45 concurrent connections.
 */

import { createClient, LiveTTSEvents } from "@deepgram/sdk";
import { concatPcm } from "./format.js";

const DEFAULT_MODEL = "aura-2-thalia-en";

export interface TTSConfig {
  voiceId?: string;
  apiKeyEnv?: string;
}

/**
 * Persistent TTS session backed by a Deepgram WebSocket connection.
 * One session per conversation test — reused across all turns.
 */
export class TTSSession {
  private client: ReturnType<typeof createClient> | null = null;
  private live: ReturnType<ReturnType<typeof createClient>["speak"]["live"]> | null = null;
  private model: string;
  private apiKey: string;
  private connected = false;

  // Synthesis state
  private audioChunks: Buffer[] = [];
  private resolveFlush: ((buf: Buffer) => void) | null = null;
  private rejectFlush: ((err: Error) => void) | null = null;
  private resolveClear: (() => void) | null = null;

  constructor(config?: TTSConfig) {
    this.apiKey = process.env[config?.apiKeyEnv ?? "DEEPGRAM_API_KEY"] ?? "";
    if (!this.apiKey) {
      throw new Error(`Missing Deepgram API key (env: ${config?.apiKeyEnv ?? "DEEPGRAM_API_KEY"})`);
    }
    this.model = config?.voiceId ?? DEFAULT_MODEL;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    // Clean up any stale state from a previous connection
    this.audioChunks = [];
    this.resolveFlush = null;
    this.rejectFlush = null;
    this.resolveClear = null;

    this.client = createClient(this.apiKey);
    this.live = this.client.speak.live({
      model: this.model,
      encoding: "linear16",
      sample_rate: 24000,
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Deepgram TTS WebSocket connection timeout (10s)"));
      }, 10_000);

      this.live!.on(LiveTTSEvents.Open, () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });

      this.live!.on(LiveTTSEvents.Error, (err: unknown) => {
        if (!this.connected) {
          clearTimeout(timeout);
          reject(new Error(`Deepgram TTS WebSocket error: ${err}`));
        } else {
          console.error("[tts] WebSocket error:", err);
          // Reject any pending synthesis
          if (this.rejectFlush) {
            this.rejectFlush(new Error(`Deepgram TTS WebSocket error: ${err}`));
            this.rejectFlush = null;
            this.resolveFlush = null;
            this.audioChunks = [];
          }
        }
      });

      this.live!.on(LiveTTSEvents.Close, () => {
        this.connected = false;
        // Reject any pending synthesis
        if (this.rejectFlush) {
          this.rejectFlush(new Error("Deepgram TTS WebSocket closed unexpectedly"));
          this.rejectFlush = null;
          this.resolveFlush = null;
          this.audioChunks = [];
        }
      });

      this.live!.on(LiveTTSEvents.Audio, (data: Buffer) => {
        this.audioChunks.push(data);
      });

      this.live!.on(LiveTTSEvents.Flushed, () => {
        if (this.resolveFlush) {
          const buf = concatPcm(this.audioChunks);
          this.audioChunks = [];
          this.resolveFlush(buf);
          this.resolveFlush = null;
          this.rejectFlush = null;
        }
      });

      // Cleared responses come through as Unhandled since the SDK doesn't have a Cleared event
      this.live!.on(LiveTTSEvents.Unhandled, (data: { type?: string }) => {
        if (data?.type === "Cleared" && this.resolveClear) {
          this.audioChunks = [];
          this.resolveClear();
          this.resolveClear = null;
        }
      });
    });
  }

  /**
   * Synthesize text to PCM audio. Sends text + flush, collects audio chunks,
   * returns complete buffer when Flushed confirmation arrives.
   * Auto-reconnects once if the session was closed (e.g. Deepgram idle timeout).
   */
  async synthesize(text: string): Promise<Buffer> {
    if (!text.trim()) return Buffer.alloc(0);

    // Auto-reconnect if Deepgram closed the connection
    if (!this.connected || !this.live) {
      console.log("[tts] Session disconnected — reconnecting…");
      this.live = null;
      this.client = null;
      this.connected = false;
      await this.connect();
    }

    return new Promise<Buffer>((resolve, reject) => {
      this.audioChunks = [];
      this.resolveFlush = resolve;
      this.rejectFlush = reject;
      this.live!.sendText(text);
      this.live!.flush();
    });
  }

  /**
   * Stream-synthesize text to PCM audio. Yields 24kHz mono PCM chunks as
   * Deepgram generates them — the first chunk arrives after ~100ms TTFB,
   * while remaining chunks are still being generated.
   *
   * Auto-reconnects once if the session was closed.
   */
  async *synthesizeStream(text: string): AsyncGenerator<Buffer> {
    if (!text.trim()) return;

    // Auto-reconnect if Deepgram closed the connection
    if (!this.connected || !this.live) {
      console.log("[tts] Session disconnected — reconnecting…");
      this.live = null;
      this.client = null;
      this.connected = false;
      await this.connect();
    }

    // Async queue: Audio handler pushes, generator pulls
    const queue: (Buffer | null)[] = [];
    let waiting: (() => void) | null = null;
    let streamError: Error | null = null;

    const onAudio = (data: Buffer) => {
      queue.push(data);
      if (waiting) { waiting(); waiting = null; }
    };
    const onFlushed = () => {
      queue.push(null); // sentinel: end of stream
      if (waiting) { waiting(); waiting = null; }
    };
    const onError = (err: unknown) => {
      streamError = new Error(`Deepgram TTS error during stream: ${err}`);
      queue.push(null);
      if (waiting) { waiting(); waiting = null; }
    };
    const onClose = () => {
      if (queue[queue.length - 1] !== null) {
        streamError = streamError ?? new Error("Deepgram TTS closed during stream");
        queue.push(null);
        if (waiting) { waiting(); waiting = null; }
      }
    };

    // Override event handlers for streaming mode
    this.live!.removeAllListeners(LiveTTSEvents.Audio);
    this.live!.removeAllListeners(LiveTTSEvents.Flushed);
    this.live!.on(LiveTTSEvents.Audio, onAudio);
    this.live!.on(LiveTTSEvents.Flushed, onFlushed);
    this.live!.on(LiveTTSEvents.Error, onError);
    this.live!.on(LiveTTSEvents.Close, onClose);

    try {
      this.live!.sendText(text);
      this.live!.flush();

      while (true) {
        while (queue.length === 0) {
          await new Promise<void>((r) => { waiting = r; });
        }
        const chunk = queue.shift()!;
        if (chunk === null) break;
        if (streamError) throw streamError;
        yield chunk;
      }
      if (streamError) throw streamError;
    } finally {
      // Restore original handlers for buffered synthesize()
      this.live?.removeAllListeners(LiveTTSEvents.Audio);
      this.live?.removeAllListeners(LiveTTSEvents.Flushed);
      this.live?.removeListener(LiveTTSEvents.Error, onError);
      this.live?.removeListener(LiveTTSEvents.Close, onClose);
      this.live?.on(LiveTTSEvents.Audio, (data: Buffer) => {
        this.audioChunks.push(data);
      });
      this.live?.on(LiveTTSEvents.Flushed, () => {
        if (this.resolveFlush) {
          const buf = concatPcm(this.audioChunks);
          this.audioChunks = [];
          this.resolveFlush(buf);
          this.resolveFlush = null;
          this.rejectFlush = null;
        }
      });
    }
  }

  /**
   * Barge-in: clear the current synthesis buffer.
   * Discards any pending audio and waits for server confirmation.
   */
  async clear(): Promise<void> {
    if (!this.connected || !this.live) return;

    return new Promise<void>((resolve) => {
      this.resolveClear = resolve;
      // Reject any pending synthesis
      if (this.rejectFlush) {
        this.rejectFlush(new Error("Synthesis cleared (barge-in)"));
        this.rejectFlush = null;
        this.resolveFlush = null;
      }
      this.audioChunks = [];
      this.live!.clear();
      // Safety timeout — resolve after 2s even if Cleared never arrives
      setTimeout(() => {
        if (this.resolveClear) {
          this.resolveClear();
          this.resolveClear = null;
        }
      }, 2_000);
    });
  }

  /**
   * Gracefully close the WebSocket connection.
   */
  async close(): Promise<void> {
    if (this.live && this.connected) {
      this.live.requestClose();
      // Give the server a moment to close gracefully
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      this.live.disconnect();
    }
    this.live = null;
    this.client = null;
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

}

/**
 * Convenience function — creates an ephemeral session, synthesizes one text, and closes.
 * Use TTSSession directly for multi-turn conversations.
 */
export async function synthesize(text: string, config?: TTSConfig): Promise<Buffer> {
  if (!text.trim()) return Buffer.alloc(0);

  const session = new TTSSession(config);
  try {
    await session.connect();
    return await session.synthesize(text);
  } finally {
    await session.close();
  }
}
