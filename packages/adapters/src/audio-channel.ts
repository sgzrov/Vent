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
}

export interface AudioChannel {
  connect(): Promise<void>;
  /** Send raw PCM audio to the agent (16-bit 24kHz mono) */
  sendAudio(pcm: Buffer): void;
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

  get stats(): ChannelStats {
    return this._stats;
  }

  abstract connect(): Promise<void>;
  abstract sendAudio(pcm: Buffer): void;
  abstract disconnect(): Promise<void>;
  abstract get connected(): boolean;
}
