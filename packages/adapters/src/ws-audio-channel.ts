/**
 * WebSocket Audio Channel
 *
 * Bidirectional PCM audio over WebSocket with comfort noise, resampling,
 * and real-time audio pacing. Matches platform adapter quality for custom
 * and local voice agents.
 *
 * Binary frames → audio (PCM 16-bit mono, configurable sample rate)
 * Text frames   → JSON events (tool_call, vent:timing, speech-update, end-call)
 */

import WebSocket from "ws";
import type { ObservedToolCall, ComponentLatency } from "@vent/shared";
import { resample } from "@vent/voice";
import { BaseAudioChannel, type SendAudioOptions } from "./audio-channel.js";

// ---- Constants ----

const COMFORT_NOISE_INTERVAL_MS = 20;
const COMFORT_NOISE_AMPLITUDE = 400; // ~-30dBFS — keeps codec warm so VAD detects speech onset
const INTERNAL_SAMPLE_RATE = 24000;
const DEFAULT_SILENCE_THRESHOLD = 64; // max abs sample to count as silence
const DEFAULT_MAX_INTERNAL_SILENCE_FRAMES = 6; // 6 × 20ms = 120ms

// ---- Config ----

export interface WsAudioChannelConfig {
  wsUrl: string;
  headers?: Record<string, string>;
  /** Target sample rate for the wire format. Default: 24000 (no resampling). */
  sampleRate?: number;
  /** Enable caller audio normalization (silence trimming/collapsing). Default: false. */
  normalizeAudio?: boolean;
  /** Silence threshold for normalization (max abs sample value). Default: 64. */
  silenceThreshold?: number;
  /** Max internal silence frames before collapsing (at 20ms/frame). Default: 6 (120ms). */
  maxInternalSilenceFrames?: number;
}

// ---- Text frame event types ----

interface WsToolCallEvent {
  type: "tool_call";
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  duration_ms?: number;
}

interface WsTimingEvent {
  type: "vent:timing";
  stt_ms?: number;
  llm_ms?: number;
  tts_ms?: number;
}

// ---- Channel ----

export class WsAudioChannel extends BaseAudioChannel {
  private ws: WebSocket | null = null;
  private config: WsAudioChannelConfig;
  private toolCalls: ObservedToolCall[] = [];
  private componentTimings: ComponentLatency[] = [];
  private connectTimestamp = 0;
  private comfortNoiseTimer: ReturnType<typeof setInterval> | null = null;

  // Resolved config
  private readonly targetSampleRate: number;
  private readonly shouldNormalize: boolean;
  private readonly silenceThreshold: number;
  private readonly maxInternalSilenceFrames: number;

  /** Frame size in bytes at target sample rate (20ms of 16-bit mono PCM) */
  private get frameBytes(): number {
    return Math.floor(this.targetSampleRate * 2 * (COMFORT_NOISE_INTERVAL_MS / 1000));
  }

  /** Samples per comfort noise frame at target sample rate */
  private get frameSamples(): number {
    return Math.floor(this.targetSampleRate * (COMFORT_NOISE_INTERVAL_MS / 1000));
  }

  /** VAD remains authority for turn endings. Agents can opt in via speech-update frames. */
  hasPlatformEndOfTurn = false;

  constructor(config: WsAudioChannelConfig) {
    super();
    this.config = config;
    this.targetSampleRate = config.sampleRate ?? INTERNAL_SAMPLE_RATE;
    this.shouldNormalize = config.normalizeAudio ?? false;
    this.silenceThreshold = config.silenceThreshold ?? DEFAULT_SILENCE_THRESHOLD;
    this.maxInternalSilenceFrames = config.maxInternalSilenceFrames ?? DEFAULT_MAX_INTERNAL_SILENCE_FRAMES;
    this.enableRecordingCapture();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl, {
        headers: this.config.headers,
      });
      ws.binaryType = "nodebuffer";

      ws.on("open", () => {
        this.ws = ws;
        this.connectTimestamp = Date.now();
        this._stats.connectLatencyMs = Date.now() - connectStart;
        this.toolCalls = [];
        this.componentTimings = [];

        ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) {
            const chunk =
              data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
            this._stats.bytesReceived += chunk.length;
            // Resample from wire rate → 24kHz for consumers
            const pcm24k = this.targetSampleRate !== INTERNAL_SAMPLE_RATE
              ? resample(chunk, this.targetSampleRate, INTERNAL_SAMPLE_RATE)
              : chunk;
            this.captureAgentAudio(pcm24k, Date.now() - this.connectTimestamp);
            this.emit("audio", pcm24k);
          } else {
            this.handleTextFrame(data.toString());
          }
        });

        ws.on("error", (err) => {
          this._stats.errorEvents.push(err.message);
          this.emit("error", err);
        });

        ws.on("close", () => {
          this.stopComfortNoise();
          this.ws = null;
          this.emit("disconnected");
        });

        // Start comfort noise to keep the connection active
        this.startComfortNoise();
        resolve();
      });

      ws.on("error", (err) => {
        reject(new Error(`WebSocket connection failed: ${err.message}`));
      });
    });
  }

  async sendAudio(pcm: Buffer, opts?: SendAudioOptions): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this._stats.bytesSent += pcm.length;
    // Capture at 24kHz for recording before any resampling
    this.captureCallerAudio(pcm, Date.now() - this.connectTimestamp);

    // Pause comfort noise while sending speech
    this.stopComfortNoise();

    const raw = opts?.raw ?? false;

    // 1. Resample 24kHz → targetRate (no-op if same rate)
    let outbound = this.targetSampleRate !== INTERNAL_SAMPLE_RATE
      ? resample(pcm, INTERNAL_SAMPLE_RATE, this.targetSampleRate)
      : pcm;

    // 2. Normalize (opt-in, skip if raw)
    if (!raw && this.shouldNormalize) {
      outbound = this.normalizeCallerPcm(outbound);
    }

    // 3. Pace at real-time speed (skip if raw — timing matters for interrupts/noise)
    if (!raw) {
      const fb = this.frameBytes;
      for (let i = 0; i < outbound.length; i += fb) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
        const end = Math.min(i + fb, outbound.length);
        this.ws.send(outbound.subarray(i, end));
        if (i + fb < outbound.length) {
          await sleep(COMFORT_NOISE_INTERVAL_MS);
        }
      }
    } else {
      this.ws.send(outbound);
    }

    // Resume comfort noise after speech
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.startComfortNoise();
    }
  }

  async disconnect(): Promise<void> {
    this.stopComfortNoise();
    if (this.ws) {
      // Signal end-of-call before closing (best-effort)
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "end-call" }));
        } catch {
          // Non-fatal
        }
      }
      this.ws.close();
      this.ws = null;
    }
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    return this.toolCalls;
  }

  getComponentTimings(): ComponentLatency[] {
    return this.componentTimings;
  }

  // ---- Comfort noise ----

  startComfortNoise(): void {
    if (this.comfortNoiseTimer) return;
    const samples = this.frameSamples;
    this.comfortNoiseTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopComfortNoise();
        return;
      }
      const frame = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i++) {
        const sample = Math.floor((Math.random() - 0.5) * COMFORT_NOISE_AMPLITUDE * 2);
        frame.writeInt16LE(sample, i * 2);
      }
      this.ws.send(frame);
    }, COMFORT_NOISE_INTERVAL_MS);
  }

  stopComfortNoise(): void {
    if (this.comfortNoiseTimer) {
      clearInterval(this.comfortNoiseTimer);
      this.comfortNoiseTimer = null;
    }
  }

  // ---- Caller audio normalization ----

  private normalizeCallerPcm(pcm: Buffer): Buffer {
    const fb = this.frameBytes;
    const frameCount = Math.ceil(pcm.length / fb);
    if (frameCount <= 1) return pcm;

    // Classify each frame as silent or voiced
    const silent: boolean[] = [];
    let firstVoiced = -1;
    let lastVoiced = -1;

    for (let i = 0; i < frameCount; i++) {
      const frame = pcm.subarray(i * fb, Math.min((i + 1) * fb, pcm.length));
      const isSilent = this.isEffectivelySilent(frame);
      silent.push(isSilent);
      if (!isSilent) {
        if (firstVoiced === -1) firstVoiced = i;
        lastVoiced = i;
      }
    }

    // No voiced frames → return as-is
    if (firstVoiced === -1) return pcm;

    // Build output: trim leading/trailing silence, collapse internal gaps
    const frames: Buffer[] = [];
    let i = firstVoiced;
    while (i <= lastVoiced) {
      if (!silent[i]) {
        frames.push(pcm.subarray(i * fb, Math.min((i + 1) * fb, pcm.length)));
        i++;
        continue;
      }
      // Silent run — count length, keep at most maxInternalSilenceFrames
      const runStart = i;
      while (i <= lastVoiced && silent[i]) i++;
      const runLength = i - runStart;
      const kept = Math.min(runLength, this.maxInternalSilenceFrames);
      for (let k = 0; k < kept; k++) {
        const src = runStart + k;
        frames.push(pcm.subarray(src * fb, Math.min((src + 1) * fb, pcm.length)));
      }
    }

    return Buffer.concat(frames);
  }

  private isEffectivelySilent(frame: Buffer): boolean {
    for (let offset = 0; offset + 1 < frame.length; offset += 2) {
      if (Math.abs(frame.readInt16LE(offset)) > this.silenceThreshold) return false;
    }
    return true;
  }

  // ---- Text frame handling ----

  private handleTextFrame(text: string): void {
    try {
      const event = JSON.parse(text) as { type: string; [key: string]: unknown };
      switch (event.type) {
        case "tool_call": {
          const tc = event as unknown as WsToolCallEvent;
          if (tc.name) {
            this.toolCalls.push({
              name: tc.name,
              arguments: tc.arguments ?? {},
              result: tc.result,
              successful: tc.successful,
              timestamp_ms: Date.now() - this.connectTimestamp,
              latency_ms: tc.duration_ms,
            });
          }
          break;
        }
        case "vent:timing": {
          const timing = event as unknown as WsTimingEvent;
          this.componentTimings.push({
            stt_ms: timing.stt_ms,
            llm_ms: timing.llm_ms,
            tts_ms: timing.tts_ms,
          });
          break;
        }
        case "speech-update": {
          if (!this.hasPlatformEndOfTurn) {
            this.hasPlatformEndOfTurn = true;
          }
          const status = (event as { status?: string }).status;
          if (status === "started") {
            this.emit("platformSpeechStart");
          } else if (status === "stopped") {
            this.emit("platformEndOfTurn");
          }
          break;
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
