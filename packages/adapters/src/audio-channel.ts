/**
 * AudioChannel — low-level bidirectional audio pipe.
 *
 * Adapters implement this interface to provide raw PCM send/receive
 * over a specific transport (WebSocket, WebRTC, SIP). No TTS, STT,
 * or silence detection — that lives in the test executors.
 *
 * All audio is 16-bit signed PCM, 24kHz, mono unless otherwise noted
 * in the adapter (transport-specific resampling happens internally).
 */

import { EventEmitter } from "node:events";
import type { ObservedToolCall, ChannelStats, CallMetadata, ComponentLatency } from "@vent/shared";

export interface AudioChannelEvents {
  audio: (chunk: Buffer) => void;
  error: (err: Error) => void;
  disconnected: () => void;
  /** Platform signals that the agent finished speaking (e.g. LiveKit agent state → "listening"). */
  platformEndOfTurn: () => void;
}

export interface SendAudioOptions {
  /** When true, skip anti-echo measures (silence padding, mark await, clear).
   *  Use for audio actions (interrupt, noise injection) where timing matters. */
  raw?: boolean;
}

export interface AudioChannel {
  connect(): Promise<void>;
  /** Send raw PCM audio to the agent (16-bit 24kHz mono) */
  sendAudio(pcm: Buffer, opts?: SendAudioOptions): void | Promise<void>;
  /** Stream PCM audio chunks to the agent as they arrive (16-bit 24kHz mono).
   *  Returns immediately after the last chunk is sent — does not wait for playback. */
  sendAudioStream?(stream: AsyncIterable<Buffer>, opts?: SendAudioOptions): Promise<void>;
  /** Start sending low-level comfort noise to keep the line active during processing. */
  startComfortNoise?(): void;
  /** Stop comfort noise (called automatically by sendAudioStream). */
  stopComfortNoise?(): void;
  disconnect(): Promise<void>;
  readonly connected: boolean;
  readonly stats: ChannelStats;

  /** Get tool call data after call ends. Platform adapters pull from API, websocket returns collected events. */
  getCallData?(): Promise<ObservedToolCall[]>;
  /** Get platform call metadata (cost, ended reason, recording, analysis) after call ends. */
  getCallMetadata?(): Promise<CallMetadata | null>;
  /** Get per-turn component latency breakdown (STT/LLM/TTS) from platform events. */
  getComponentTimings?(): ComponentLatency[];
  /** Get platform's own STT transcripts for cross-referencing with Vent's STT. */
  getTranscripts?(): Array<{ turnIndex: number; text: string }>;
  /** Get ALL caller speech as a single concatenated string (for WER without turn alignment). */
  getFullCallerTranscript?(): string;
  /** Consume accumulated real-time agent transcript text (resets buffer). Used as STT fallback. */
  consumeAgentText?(): string;
  /** Platform-reported concurrency limit (e.g. Vapi returns this on call creation). */
  platformConcurrencyLimit?: number | null;

  on<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this;
  off<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this;
  once<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this;
  emit<E extends keyof AudioChannelEvents>(event: E, ...args: Parameters<AudioChannelEvents[E]>): boolean;
}

export abstract class BaseAudioChannel extends EventEmitter implements AudioChannel {
  protected _stats: ChannelStats = {
    bytesSent: 0,
    bytesReceived: 0,
    errorEvents: [],
    connectLatencyMs: 0,
  };

  /** Early audio buffer — captures greeting audio before executor attaches listeners. */
  private _earlyAudioBuffer: Buffer[] = [];
  private _bufferingAudio = true;

  get stats(): ChannelStats {
    return this._stats;
  }

  /**
   * Override emit to buffer audio events before any listener attaches.
   * This ensures agent greeting audio is never lost, regardless of adapter timing.
   */
  emit<E extends keyof AudioChannelEvents>(event: E, ...args: Parameters<AudioChannelEvents[E]>): boolean {
    if (event === "audio" && this._bufferingAudio) {
      this._earlyAudioBuffer.push(args[0] as Buffer);
      return true;
    }
    return super.emit(event, ...args);
  }

  /**
   * Override on to flush buffered greeting audio when the first audio listener attaches.
   */
  on<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this {
    super.on(event, listener);
    if (event === "audio" && this._bufferingAudio) {
      this._bufferingAudio = false;
      // Flush buffered greeting audio to the new listener on next tick
      // (so the listener is fully registered before receiving events)
      const buffered = this._earlyAudioBuffer;
      this._earlyAudioBuffer = [];
      process.nextTick(() => {
        for (const chunk of buffered) {
          (listener as AudioChannelEvents["audio"])(chunk);
        }
      });
    }
    return this;
  }

  abstract connect(): Promise<void>;
  abstract sendAudio(pcm: Buffer, opts?: SendAudioOptions): void | Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract get connected(): boolean;
}
