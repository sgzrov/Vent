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

import WebSocket from "ws";
import type { TranscriptionResult } from "./types.js";

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

export interface StreamingTranscriberConfig {
  apiKeyEnv?: string;
  sampleRate?: number;
  model?: string;
}

export class StreamingTranscriber {
  private ws: WebSocket | null = null;
  private readonly apiKeyEnv: string;
  private readonly sampleRate: number;
  private readonly model: string;

  /** Accumulated final transcript segments for the current turn. */
  private finalSegments: { text: string; confidence: number }[] = [];

  /** Resolves when the next final transcript arrives after finalize() is called. */
  private finalizeResolve: ((result: TranscriptionResult) => void) | null = null;
  private finalizeCalled = false;

  /** Track whether we've received any audio this turn. */
  private hasFedAudio = false;

  constructor(config?: StreamingTranscriberConfig) {
    this.apiKeyEnv = config?.apiKeyEnv ?? "DEEPGRAM_API_KEY";
    this.sampleRate = config?.sampleRate ?? 24000;
    this.model = config?.model ?? "nova-2";
  }

  async connect(): Promise<void> {
    const apiKey = process.env[this.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Missing Deepgram API key (env: ${this.apiKeyEnv})`);
    }

    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(this.sampleRate),
      channels: "1",
      model: this.model,
      punctuate: "true",
      interim_results: "false",
      endpointing: "false",
      vad_events: "false",
    });

    const url = `${DEEPGRAM_WS_URL}?${params}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Token ${apiKey}` },
      });

      this.ws.on("open", () => resolve());

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString()) as DeepgramWSMessage;
          if (msg.type === "Results" && msg.is_final) {
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
          }
        } catch {
          // Ignore parse errors on non-JSON messages
        }
      });

      this.ws.on("error", (err) => {
        if (this.finalizeResolve) {
          // Return whatever we have so far
          this.resolveFinalTranscript();
        } else {
          reject(err);
        }
      });

      this.ws.on("close", () => {
        if (this.finalizeResolve) {
          this.resolveFinalTranscript();
        }
      });
    });
  }

  /**
   * Feed raw PCM audio into the WebSocket.
   * Call this for every audio chunk received from the channel.
   */
  feedAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
      this.hasFedAudio = true;
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
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Finalize" }));
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
  }

  /** Close the WebSocket connection. */
  close(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.ws.close();
      this.ws = null;
    }
  }

  /** Whether the connection is open and usable. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
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

interface DeepgramWSMessage {
  type: string;
  is_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
}
