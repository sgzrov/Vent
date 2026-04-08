/**
 * Deepgram Aura-2 TTS — converts text to PCM 16-bit 24kHz mono audio.
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
   * Start a streaming TTS session. Audio listener is set up BEFORE any text
   * is sent, so audio chunks from Deepgram are captured as they arrive.
   *
   * Usage:
   *   const stream = ttsSession.startStreaming();
   *   stream.sendText("First sentence. ");  // audio starts flowing immediately
   *   stream.sendText("Second sentence. "); // more audio flows
   *   const audioChunks = await stream.finish(); // flush + collect remaining
   *
   * Audio chunks are available via the onAudio callback passed to startStreaming.
   */
  startStreaming(onAudio: (chunk: Buffer) => void): TTSStream {
    if (!this.connected || !this.live) {
      throw new Error("TTS session not connected");
    }

    // Replace default Audio handler to pipe chunks to the caller
    this.live!.removeAllListeners(LiveTTSEvents.Audio);
    this.audioChunks = [];

    this.live!.on(LiveTTSEvents.Audio, (data: Buffer) => {
      onAudio(data);
    });

    return new TTSStream(this.live!, () => {
      // Restore default Audio handler on finish
      this.live!.removeAllListeners(LiveTTSEvents.Audio);
      this.live!.on(LiveTTSEvents.Audio, (data: Buffer) => {
        this.audioChunks.push(data);
      });
    });
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

/**
 * Represents an active TTS streaming session. Text can be sent incrementally
 * via sendText(). Audio chunks flow back immediately via the onAudio callback.
 * Call finish() to flush remaining buffer and wait for completion.
 */
class TTSStream {
  private live: ReturnType<ReturnType<typeof createClient>["speak"]["live"]>;
  private cleanup: () => void;

  constructor(
    live: ReturnType<ReturnType<typeof createClient>["speak"]["live"]>,
    cleanup: () => void,
  ) {
    this.live = live;
    this.cleanup = cleanup;
  }

  /** Send text to Deepgram. Audio starts flowing back immediately. */
  sendText(text: string): void {
    if (!text.trim()) return;
    this.live.sendText(text);
  }

  /**
   * Flush remaining buffer and wait for Flushed confirmation.
   * Restores the default Audio handler after completion.
   */
  async finish(): Promise<void> {
    this.live.flush();
    await new Promise<void>((resolve) => {
      const onFlushed = () => {
        resolve();
      };
      this.live.once(LiveTTSEvents.Flushed, onFlushed);
      // Safety timeout
      setTimeout(() => {
        resolve();
      }, 5000);
    });
    this.cleanup();
  }
}
