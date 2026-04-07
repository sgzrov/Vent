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
import type { ObservedToolCall, ComponentLatency, CallMetadata, CallTransfer, ProviderWarning } from "@vent/shared";
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
  provider_tool_type?: string;
  tool_type?: string;
  duration_ms?: number;
}

interface WsTimingEvent {
  type: "vent:timing";
  stt_ms?: number;
  llm_ms?: number;
  tts_ms?: number;
}

interface WsTranscriptEvent {
  type: "vent:transcript";
  role?: string;
  text?: string;
  turn_index?: number;
  final?: boolean;
}

interface WsTransferEvent {
  type: "vent:transfer";
  transfer?: CallTransfer;
  destination?: string;
  status?: CallTransfer["status"];
  transfer_type?: string;
  timestamp_ms?: number;
  source?: CallTransfer["sources"][number];
}

interface WsDebugUrlEvent {
  type: "vent:debug-url";
  label?: string;
  url?: string;
}

// ---- Channel ----

export class WsAudioChannel extends BaseAudioChannel {
  private ws: WebSocket | null = null;
  private config: WsAudioChannelConfig;
  private toolCalls: ObservedToolCall[] = [];
  private componentTimings: ComponentLatency[] = [];
  private platformTranscripts: Array<{ turnIndex: number; text: string }> = [];
  private fullCallerTranscriptParts: string[] = [];
  private agentTextBuffer = "";
  private callMetadata: CallMetadata = { platform: "websocket" };
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
        this.platformTranscripts = [];
        this.fullCallerTranscriptParts = [];
        this.agentTextBuffer = "";
        this.callMetadata = { platform: "websocket" };

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

  async getCallMetadata(): Promise<CallMetadata | null> {
    return hasCallMetadataContent(this.callMetadata) ? this.callMetadata : null;
  }

  getComponentTimings(): ComponentLatency[] {
    return this.componentTimings;
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    return this.platformTranscripts;
  }

  getFullCallerTranscript(): string {
    return this.fullCallerTranscriptParts.join(" ");
  }

  consumeAgentText(): string {
    const text = this.agentTextBuffer;
    this.agentTextBuffer = "";
    return text;
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
              provider_tool_type: tc.provider_tool_type ?? tc.tool_type,
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
        case "vent:session": {
          this.mergeCallMetadata(normalizeWsMetadata(event));
          break;
        }
        case "vent:call-metadata": {
          const payload = event.call_metadata;
          const metadata = payload && typeof payload === "object"
            ? normalizeWsMetadata(payload as Record<string, unknown>)
            : normalizeWsMetadata(event);
          this.mergeCallMetadata(metadata);
          break;
        }
        case "vent:transcript": {
          this.handleTranscriptEvent(event as WsTranscriptEvent);
          break;
        }
        case "vent:transfer": {
          this.handleTransferEvent(event as WsTransferEvent);
          break;
        }
        case "vent:debug-url": {
          this.handleDebugUrlEvent(event as WsDebugUrlEvent);
          break;
        }
        case "vent:warning": {
          this.handleWarningEvent(event);
          break;
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  private mergeCallMetadata(metadata: Partial<CallMetadata>): void {
    if (!metadata.platform) {
      metadata.platform = this.callMetadata.platform;
    }

    this.callMetadata = {
      ...this.callMetadata,
      ...metadata,
      recording_variants: {
        ...(this.callMetadata.recording_variants ?? {}),
        ...(metadata.recording_variants ?? {}),
      },
      provider_debug_urls: {
        ...(this.callMetadata.provider_debug_urls ?? {}),
        ...(metadata.provider_debug_urls ?? {}),
      },
      provider_metadata: {
        ...(this.callMetadata.provider_metadata ?? {}),
        ...(metadata.provider_metadata ?? {}),
      },
      variables: {
        ...(this.callMetadata.variables ?? {}),
        ...(metadata.variables ?? {}),
      },
      provider_warnings: mergeProviderWarnings(this.callMetadata.provider_warnings, metadata.provider_warnings),
      transfers: mergeTransfers(this.callMetadata.transfers, metadata.transfers),
    };
  }

  private handleTranscriptEvent(event: WsTranscriptEvent): void {
    const text = typeof event.text === "string" ? event.text.trim() : "";
    if (!text) return;
    const role = (event.role ?? "").toLowerCase();
    const turnIndex = typeof event.turn_index === "number" ? event.turn_index : undefined;

    if (role === "caller" || role === "user") {
      if (turnIndex != null) {
        this.platformTranscripts.push({ turnIndex, text });
      } else {
        this.platformTranscripts.push({ turnIndex: this.platformTranscripts.length, text });
      }
      this.fullCallerTranscriptParts.push(text);
      return;
    }

    if (role === "agent" || role === "assistant") {
      this.agentTextBuffer += (this.agentTextBuffer ? " " : "") + text;
    }
  }

  private handleTransferEvent(event: WsTransferEvent): void {
    const transfer = event.transfer ?? {
      type: event.transfer_type ?? "transfer",
      destination: event.destination,
      status: event.status ?? "unknown",
      sources: [event.source ?? "platform_event"],
      timestamp_ms: event.timestamp_ms,
    };
    this.mergeCallMetadata({ transfers: [transfer] });
  }

  private handleDebugUrlEvent(event: WsDebugUrlEvent): void {
    if (!event.label || !event.url) return;
    this.mergeCallMetadata({
      provider_debug_urls: {
        [event.label]: event.url,
      },
    });
  }

  private handleWarningEvent(event: { [key: string]: unknown }): void {
    const warning = compactProviderWarning({
      message: typeof event.message === "string" ? event.message : undefined,
      code: typeof event.code === "string" ? event.code : undefined,
      detail: event.detail,
    });
    if (!warning) return;

    this.mergeCallMetadata({
      provider_warnings: [warning],
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWsMetadata(payload: Record<string, unknown>): Partial<CallMetadata> {
  const providerDebugUrls = firstRecord(payload["provider_debug_urls"], payload["debug_urls"]);
  const recordingVariants = firstRecord(payload["recording_variants"]);
  const providerMetadata = firstRecord(payload["provider_metadata"]);
  const variables = firstRecord(payload["variables"]);
  const providerWarnings = normalizeProviderWarnings(payload["provider_warnings"], payload["warnings"]);

  return compactUnknownRecord({
    platform: firstString(payload["platform"]) ?? "websocket",
    provider_call_id: firstString(payload["provider_call_id"], payload["call_id"]),
    provider_session_id: firstString(payload["provider_session_id"], payload["session_id"]),
    ended_reason: firstString(payload["ended_reason"]),
    cost_usd: firstNumber(payload["cost_usd"]),
    cost_breakdown: firstRecord(payload["cost_breakdown"]),
    recording_url: firstString(payload["recording_url"]),
    recording_variants: compactStringRecord(recordingVariants),
    provider_debug_urls: compactStringRecord(providerDebugUrls),
    variables,
    provider_warnings: providerWarnings,
    provider_metadata: {
      ...providerMetadata,
      duration_s: firstNumber(payload["duration_s"]),
      summary: firstString(payload["summary"]),
      success_evaluation: firstString(payload["success_evaluation"]),
      user_sentiment: firstString(payload["user_sentiment"]),
      call_successful: firstBoolean(payload["call_successful"]),
      answered_by: firstString(payload["answered_by"]),
    },
  }) as Partial<CallMetadata>;
}

function compactStringRecord(record: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const compacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 0) {
      compacted[key] = value;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactUnknownRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function compactProviderWarning(warning: ProviderWarning): ProviderWarning | undefined {
  const entries = Object.entries(warning).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) as ProviderWarning : undefined;
}

function normalizeProviderWarnings(...values: unknown[]): ProviderWarning[] | undefined {
  const warnings: ProviderWarning[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      warnings.push({ message: value });
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) {
        warnings.push({ message: item });
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const warning = compactProviderWarning({
        message: firstString(record["message"], record["warning"], record["text"]),
        code: firstString(record["code"], record["type"]),
        detail: record["detail"] ?? record["data"],
      });
      if (warning) warnings.push(warning);
    }
  }
  return warnings.length > 0 ? warnings : undefined;
}

function mergeProviderWarnings(
  existing: ProviderWarning[] | undefined,
  incoming: ProviderWarning[] | undefined,
): ProviderWarning[] | undefined {
  if ((!existing || existing.length === 0) && (!incoming || incoming.length === 0)) return undefined;
  const merged = new Map<string, ProviderWarning>();
  for (const warning of [...(existing ?? []), ...(incoming ?? [])]) {
    const normalized = compactProviderWarning(warning);
    if (!normalized) continue;
    merged.set(stableProviderWarningFingerprint(normalized), normalized);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function stableProviderWarningFingerprint(warning: ProviderWarning): string {
  return JSON.stringify({
    message: warning.message,
    code: warning.code,
    detail: warning.detail,
  });
}

function mergeTransfers(
  existing: CallTransfer[] | undefined,
  incoming: CallTransfer[] | undefined,
): CallTransfer[] | undefined {
  if ((!existing || existing.length === 0) && (!incoming || incoming.length === 0)) return undefined;
  const merged = new Map<string, CallTransfer>();
  for (const transfer of [...(existing ?? []), ...(incoming ?? [])]) {
    const key = stableTransferFingerprint(transfer);
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, {
        ...transfer,
        sources: [...new Set(transfer.sources)],
      });
      continue;
    }

    merged.set(key, {
      ...prior,
      sources: [...new Set([...prior.sources, ...transfer.sources])],
      timestamp_ms: prior.timestamp_ms ?? transfer.timestamp_ms,
    });
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function stableTransferFingerprint(transfer: CallTransfer): string {
  return JSON.stringify({
    type: transfer.type,
    destination: transfer.destination,
    status: transfer.status,
    timestamp_ms: transfer.timestamp_ms,
  });
}

function hasCallMetadataContent(metadata: CallMetadata): boolean {
  return metadata.provider_call_id != null
    || metadata.provider_session_id != null
    || metadata.ended_reason != null
    || metadata.cost_usd != null
    || metadata.recording_url != null
    || metadata.variables != null
    || metadata.provider_warnings != null
    || metadata.provider_metadata != null
    || metadata.provider_debug_urls != null
    || metadata.recording_variants != null
    || metadata.transfers != null;
}
