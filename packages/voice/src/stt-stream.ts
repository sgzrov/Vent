/**
 * Streaming STT via Deepgram WebSocket.
 *
 * Opens a persistent WebSocket to Deepgram's live transcription API.
 * Audio chunks are piped in real-time during collection. Deepgram emits
 * is_final segments as it processes — these accumulate in finalSegments
 * and are available instantly via getAccumulatedTranscript().
 *
 * At end-of-turn, the executor reads the accumulated transcript (no network
 * call) and optionally sends a non-blocking Finalize to flush any trailing
 * audio. The connection stays open across turns.
 *
 * Usage:
 *   const transcriber = new StreamingTranscriber();
 *   await transcriber.connect();
 *   // During audio collection:
 *   transcriber.feedAudio(chunk);
 *   // When end-of-turn fires — instant, no network call:
 *   const { text, confidence } = transcriber.getAccumulatedTranscript();
 *   transcriber.finalizeInBackground(); // non-blocking flush
 *   // For next turn — keeps connection alive:
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

  /** Track whether we've received any audio this turn. */
  private hasFedAudio = false;

  /** Audio buffered while connection is being established. */
  private pendingAudio: Buffer[] = [];

  /** KeepAlive interval to prevent Deepgram's 10s idle timeout. */
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  /** Whether a reconnection is in progress. */
  private reconnecting = false;

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
        endpointing: 300,
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
        this.keepAliveInterval = setInterval(() => {
          if (this.connection?.isConnected()) {
            this.connection.keepAlive();
          }
        }, 5000);

        // Replay any audio buffered while connecting
        if (this.pendingAudio.length > 0) {
          console.log(`[STT] Connected — replaying ${this.pendingAudio.length} buffered chunks`);
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
        }

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
        },
      );

      this.connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[STT] Deepgram error: ${msg}`);
        rejectOnce(err);
      });

      this.connection.on(LiveTranscriptionEvents.Close, () => {
        this.clearKeepAlive();
        if (settled) {
          console.warn("[STT] Deepgram connection closed — will reconnect on next feedAudio()");
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
   * Buffers audio if the connection isn't ready yet (replayed on Open).
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
            console.log(`[STT] Reconnected to Deepgram`);
            this.reconnecting = false;
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
   * Send Finalize to flush trailing audio and wait up to 500ms for any
   * remaining is_final segments. Returns the accumulated transcript.
   *
   * Like Pipecat: if a new segment arrives quickly (Finalize response),
   * resolve immediately. Otherwise timeout at 500ms with what we have.
   * Connection stays open.
   */
  async finalize(): Promise<TranscriptionResult> {
    if (!this.hasFedAudio) {
      return { text: "", confidence: 0 };
    }

    const segmentsBefore = this.finalSegments.length;
    const textBefore = this.finalSegments.map((s) => s.text).join(" ");
    console.log(`[STT] finalize segments=${segmentsBefore} text="${textBefore.slice(0, 100)}"`);

    // Send Finalize to flush Deepgram's buffer — keeps connection open.
    if (this.connection?.isConnected()) {
      this.connection.finalize();
    } else {
      return this.buildTranscript();
    }

    // Wait up to 500ms for any new segments from the flush.
    // Resolve immediately if a new segment arrives (Finalize response is fast).
    return new Promise<TranscriptionResult>((resolve) => {
      const startCount = this.finalSegments.length;

      // Check every 50ms if new segments arrived
      const checkInterval = setInterval(() => {
        if (this.finalSegments.length > startCount) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          const result = this.buildTranscript();
          console.log(`[STT] finalize resolved early segments=${this.finalSegments.length} text="${result.text.slice(0, 100)}"`);
          resolve(result);
        }
      }, 50);

      // Hard timeout at 500ms
      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        const result = this.buildTranscript();
        console.log(`[STT] finalize timeout (500ms) segments=${this.finalSegments.length} text="${result.text.slice(0, 100)}"`);
        resolve(result);
      }, 500);
    });
  }

  /**
   * Reset state for the next conversation turn.
   * Keeps the WebSocket connection alive — no reconnect needed.
   */
  resetForNextTurn(): void {
    this.finalSegments = [];
    this.hasFedAudio = false;
    this.pendingAudio = [];

    // If connection died, reconnect
    if (!this.connection?.isConnected() && !this.reconnecting) {
      this.connect().catch((err) => {
        console.warn(`[STT] Reconnect failed: ${err instanceof Error ? err.message : err}`);
      });
    }
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
}
