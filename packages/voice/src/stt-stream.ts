/**
 * Streaming STT via Deepgram WebSocket.
 *
 * Opens a persistent WebSocket to Deepgram's live transcription API.
 * Audio chunks are piped in real-time during collection, so the transcript
 * is available almost immediately when end-of-turn fires (~200ms vs 1-2s batch).
 *
 * Usage:
 *   const transcriber = new StreamingTranscriber();
 *   await transcriber.connect();
 *   // During audio collection:
 *   transcriber.feedAudio(chunk);
 *   // When end-of-turn fires:
 *   const { text, confidence } = await transcriber.finalize();
 *   // For next turn — keeps WS open:
 *   transcriber.resetForNextTurn();
 *   // When done:
 *   transcriber.close();
 */

import {
  createClient,
  LiveTranscriptionEvents,
  type ListenLiveClient,
  type LiveTranscriptionEvent,
} from "@deepgram/sdk";
import type { TranscriptionResult } from "./types.js";

export interface StreamingTranscriberConfig {
  apiKeyEnv?: string;
  sampleRate?: number;
  model?: string;
  /** ISO 639-1 language code for STT (e.g., "es", "fr"). Defaults to English if not set. */
  language?: string;
}

export class StreamingTranscriber {
  private connection: ListenLiveClient | null = null;
  private readonly apiKeyEnv: string;
  private readonly sampleRate: number;
  private readonly model: string;
  private readonly language: string | undefined;

  /** Accumulated final transcript segments for the current turn. */
  private finalSegments: { text: string; confidence: number }[] = [];

  /** Resolves when the next final transcript arrives after finalize() is called. */
  private finalizeResolve: ((result: TranscriptionResult) => void) | null = null;
  private finalizeCalled = false;

  /** Track whether we've received any audio this turn. */
  private hasFedAudio = false;

  /** KeepAlive interval to prevent Deepgram's 10s idle timeout. */
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  /** Whether a reconnection is in progress. */
  private reconnecting = false;

  /** Audio buffered during reconnection — replayed once connected. */
  private pendingAudio: Buffer[] = [];

  constructor(config?: StreamingTranscriberConfig) {
    this.apiKeyEnv = config?.apiKeyEnv ?? "DEEPGRAM_API_KEY";
    this.sampleRate = config?.sampleRate ?? 24000;
    this.model = config?.model ?? "nova-2";
    this.language = config?.language;
  }

  async connect(): Promise<void> {
    const apiKey = process.env[this.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Missing Deepgram API key (env: ${this.apiKeyEnv})`);
    }

    const deepgram = createClient(apiKey);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.connection = deepgram.listen.live({
        encoding: "linear16",
        sample_rate: this.sampleRate,
        channels: 1,
        model: this.model,
        punctuate: true,
        interim_results: false,
        endpointing: false,
        vad_events: false,
        ...(this.language ? { language: this.language } : {}),
      });

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const rejectOnce = (err: unknown) => {
        if (settled) return;
        settled = true;
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`Deepgram streaming STT connection failed: ${msg}`));
      };

      this.connection.on(LiveTranscriptionEvents.Open, () => {
        // Send KeepAlive every 5s to prevent Deepgram's 10s idle timeout.
        // Between conversation turns, dead time (LLM + TTS + agent processing)
        // can exceed 10s, causing silent connection drops.
        this.keepAliveInterval = setInterval(() => {
          if (this.connection?.isConnected()) {
            this.connection.keepAlive();
          }
        }, 5000);
        resolveOnce();
      });

      this.connection.on(
        LiveTranscriptionEvents.Transcript,
        (msg: LiveTranscriptionEvent) => {
          if (!msg.is_final) {
            return;
          }

          const alt = msg.channel?.alternatives?.[0];
          const text = alt?.transcript ?? "";
          const confidence = alt?.confidence ?? 0;

          if (text.length > 0) {
            this.finalSegments.push({ text, confidence });
          }

          // If finalize() was called and we got the final result, resolve
          if (this.finalizeCalled) {
            this.resolveFinalTranscript();
          }
        },
      );

      this.connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[STT] Deepgram error: ${msg}`);
        if (this.finalizeResolve) {
          this.resolveFinalTranscript();
        } else {
          rejectOnce(err);
        }
      });

      this.connection.on(LiveTranscriptionEvents.Close, () => {
        this.clearKeepAlive();
        if (this.finalizeResolve) {
          this.resolveFinalTranscript();
          return;
        }

        if (settled) {
          console.warn("[STT] Deepgram connection closed — will reconnect on next feedAudio()");
          // Mark connection as dead so feedAudio() triggers reconnect
          this.connection?.removeAllListeners();
          this.connection = null;
        } else {
          rejectOnce("socket closed before connection opened");
        }
      });
    });
  }

  /**
   * Feed raw PCM audio into the WebSocket.
   * Call this for every audio chunk received from the channel.
   * Auto-reconnects if the connection was lost.
   */
  feedAudio(chunk: Buffer): void {
    if (this.connection?.isConnected()) {
      const audio = chunk.buffer.slice(
        chunk.byteOffset,
        chunk.byteOffset + chunk.byteLength,
      );
      this.connection.send(audio);
      this.hasFedAudio = true;
    } else {
      // Buffer audio so it can be replayed after reconnect
      this.pendingAudio.push(Buffer.from(chunk));

      if (!this.reconnecting) {
        console.warn("[STT] Deepgram connection lost — reconnecting…");
        this.reconnecting = true;
        this.connect()
          .then(() => {
            console.log(`[STT] Reconnected to Deepgram — replaying ${this.pendingAudio.length} buffered chunks`);
            this.reconnecting = false;
            // Replay buffered audio
            for (const buffered of this.pendingAudio) {
              if (this.connection?.isConnected()) {
                const audio = buffered.buffer.slice(
                  buffered.byteOffset,
                  buffered.byteOffset + buffered.byteLength,
                );
                this.connection.send(audio);
                this.hasFedAudio = true;
              }
            }
            this.pendingAudio = [];
          })
          .catch((err) => {
            console.warn(`[STT] Reconnect failed: ${err instanceof Error ? err.message : err}`);
            this.reconnecting = false;
            this.pendingAudio = [];
          });
      }
    }
  }

  /**
   * Signal end of audio for this turn and wait for the final transcript.
   * Sends a Finalize message to Deepgram which flushes any buffered audio.
   */
  async finalize(): Promise<TranscriptionResult> {
    if (!this.hasFedAudio) {
      return { text: "", confidence: 0 };
    }

    // Send Finalize to flush Deepgram's buffer
    if (this.connection?.isConnected()) {
      this.connection.finalize();
    }

    this.finalizeCalled = true;

    // If we already have segments, resolve immediately
    if (this.finalSegments.length > 0) {
      return this.buildTranscript();
    }

    // Wait for the final transcript (with timeout)
    return new Promise<TranscriptionResult>((resolve) => {
      this.finalizeResolve = resolve;

      // Safety timeout — don't hang forever
      setTimeout(() => {
        if (this.finalizeResolve) {
          this.resolveFinalTranscript();
        }
      }, 3000);
    });
  }

  /**
   * Reset state for the next conversation turn.
   * Keeps the WebSocket connection alive.
   */
  resetForNextTurn(): void {
    this.finalSegments = [];
    this.finalizeResolve = null;
    this.finalizeCalled = false;
    this.hasFedAudio = false;
    this.pendingAudio = [];
  }

  /** Close the WebSocket connection. */
  close(): void {
    this.clearKeepAlive();
    if (this.connection) {
      if (this.connection.isConnected()) {
        this.connection.requestClose();
      }
      this.connection.removeAllListeners();
      this.connection.disconnect();
      this.connection = null;
    }
  }

  private clearKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  /** Whether the connection is open and usable. */
  get connected(): boolean {
    return this.connection?.isConnected() ?? false;
  }

  private buildTranscript(): TranscriptionResult {
    if (this.finalSegments.length === 0) {
      return { text: "", confidence: 0 };
    }

    const text = this.finalSegments.map((s) => s.text).join(" ");
    const confidence =
      this.finalSegments.reduce((sum, s) => sum + s.confidence, 0) /
      this.finalSegments.length;

    return { text, confidence };
  }

  private resolveFinalTranscript(): void {
    const result = this.buildTranscript();
    const resolve = this.finalizeResolve;
    this.finalizeResolve = null;
    this.finalizeCalled = false;
    resolve?.(result);
  }
}
