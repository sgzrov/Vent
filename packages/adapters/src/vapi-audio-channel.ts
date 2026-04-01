/**
 * Vapi Audio Channel
 *
 * Creates a call via Vapi's API with WebSocket transport, exchanges
 * binary PCM audio, and pulls tool call data after the call via GET /call/{id}.
 *
 * Audio format: PCM 16-bit signed little-endian, 16kHz (Vapi's native WS format).
 * Resampling from 24kHz→16kHz on send, 16kHz→24kHz on receive.
 *
 * Also parses WebSocket text frames (JSON control messages) for component
 * latency breakdown (STT/LLM/TTS timing per turn), real-time tool calls,
 * interruption tracking, and agent transcript capture.
 */

import WebSocket from "ws";
import { VapiClient, type Vapi } from "@vapi-ai/server-sdk";
import type { ObservedToolCall, CallMetadata, ComponentLatency } from "@vent/shared";
import { resample } from "@vent/voice";
import { BaseAudioChannel, type SendAudioOptions } from "./audio-channel.js";

export interface VapiAudioChannelConfig {
  apiKey: string;
  assistantId: string;
}

interface VapiAssistantRuntimeConfig {
  firstMessageMode?: string;
  firstMessage?: string;
  maxDurationSeconds?: number;
  firstMessageInterruptionsEnabled?: boolean;
  startSpeakingWaitSeconds?: number;
}

interface VapiCreateCallResponse {
  id: string;
  transport?: {
    websocketCallUrl?: string;
  };
  monitor?: {
    controlUrl?: string;
  };
  subscriptionLimits?: {
    concurrencyLimit?: number;
    remainingConcurrentCalls?: number;
    concurrencyBlocked?: boolean;
  };
}

interface VapiCallMessage {
  role: string;
  message?: string;
  toolCalls?: Array<{
    id?: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  toolCallId?: string;
  result?: string;
  secondsFromStart?: number;
}

interface VapiCallResponse {
  id: string;
  status: string;
  endedReason?: string;
  duration?: number;
  costBreakdown?: {
    stt?: number;
    llm?: number;
    tts?: number;
    transport?: number;
    vapi?: number;
    total?: number;
    llmPromptTokens?: number;
    llmCompletionTokens?: number;
  };
  analysis?: {
    summary?: string;
    successEvaluation?: string;
  };
  artifact?: {
    messages?: VapiCallMessage[];
    transcript?: string;
    recording?: unknown;
    recordingUrl?: string;
  };
}

/** Per-turn timing from WebSocket text frame events */
interface TurnTiming {
  audioSentAt?: number;
  outboundFirstFrameAt?: number;
  outboundLastFrameAt?: number;
  outboundFrameCount?: number;
  sttDoneAt?: number;
  llmFirstTokenAt?: number;
  speechStartAt?: number;
  speechStopAt?: number;
  vapiTranscript?: string;
}

interface OutboundFrame {
  buffer: Buffer;
  turnIndex: number;
  frameIndex: number;
  totalFrames: number;
}

/** Comfort noise: 20ms frame at 16kHz = 320 samples = 640 bytes */
const COMFORT_NOISE_FRAME_SAMPLES = 320;
const COMFORT_NOISE_INTERVAL_MS = 20;
const COMFORT_NOISE_AMPLITUDE = 400; // ~-30dBFS — keeps codec warm so VAD detects speech onset
const VAPI_FRAME_BYTES = COMFORT_NOISE_FRAME_SAMPLES * 2;
const VAPI_CALLER_SILENCE_MAX_ABS = 64;
const VAPI_CALLER_MAX_INTERNAL_SILENCE_FRAMES = 6; // 120ms at 20ms/frame
const TURN_END_SILENCE_MS = 400;
const TURN_END_SILENCE_FRAMES = Math.ceil(TURN_END_SILENCE_MS / COMFORT_NOISE_INTERVAL_MS);
const TOOL_CALL_TIMEOUT_MS = 30_000;
const TOOL_RESULT_PENDING_SENTINEL = "Tool Result Still Pending But Proceed Further If Possible.";
const VAPI_MIN_START_SPEAKING_WAIT_SECONDS = 1.2;

/** WebSocket connect timeout */
const WS_CONNECT_TIMEOUT_MS = 30_000;

export class VapiAudioChannel extends BaseAudioChannel {
  private config: VapiAudioChannelConfig;
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private controlUrl: string | null = null;
  private cachedCallResponse: VapiCallResponse | null = null;
  private cachedAssistantRuntimeConfig: VapiAssistantRuntimeConfig | null | undefined;

  /** Vapi account concurrency limit, populated after first connect() */
  platformConcurrencyLimit: number | null = null;

  /** Vapi speech-update is useful for turn correlation, but not reliable enough as the
   *  runtime end-of-turn source. Vent keeps VAD as the authority for Vapi turn endings. */
  hasPlatformEndOfTurn = false;
  /** Retained for diagnostics; unused while Vapi relies on VAD for turn endings. */
  platformEndOfTurnDrainMs = 1000;
  /** After a tool result lands, Vapi sometimes resumes the same spoken thought after a short pause. */
  postToolCallContinuationMs = 2000;
  /** Vapi also occasionally pauses briefly mid-sentence before finishing the same turn. */
  postVadContinuationMs = 1000;
  /** Start more conservatively on Vapi to avoid cutting across internal pauses. */
  preferredSilenceThresholdMs = 1200;

  // Component latency tracking from WebSocket text frames
  private turnTimings: TurnTiming[] = [];
  private currentTurnIndex = -1;
  private awaitingLlmFirstToken = false;
  private activeAssistantResponseTurnIndex: number | null = null;
  private activeAssistantPlatformTurn: number | null = null;
  private assistantResponseTurnIndexByPlatformTurn = new Map<number, number>();

  // Real-time tool calls from WebSocket events
  private realtimeToolCalls: Array<{ id?: string; call: ObservedToolCall }> = [];

  // Agent transcript accumulator for consumeAgentText()
  private agentTextBuffer = "";

  // Call start timestamp for relative timing
  private connectTimestamp = 0;

  // Tool call tracking — cleared when conversation history shows the real tool result.
  private toolCallActiveUntil = 0;
  private toolCallStartedAt = 0;
  private pendingToolCallIds = new Set<string>();

  // Comfort noise state
  private comfortNoiseTimer: ReturnType<typeof setInterval> | null = null;
  private outboundFrames: OutboundFrame[] = [];
  private outboundPumpPromise: Promise<void> | null = null;

  // End-of-call report received via WebSocket (best-effort cache only)
  private endOfCallReport: Record<string, unknown> | null = null;

  // Call transfer tracking
  private transfers: Array<{ type: string; timestamp: number; detail: unknown }> = [];

  constructor(config: VapiAudioChannelConfig) {
    super();
    this.config = config;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    this.connectTimestamp = connectStart;
    this.turnTimings = [];
    this.currentTurnIndex = -1;
    this.awaitingLlmFirstToken = false;
    this.activeAssistantResponseTurnIndex = null;
    this.activeAssistantPlatformTurn = null;
    this.assistantResponseTurnIndexByPlatformTurn.clear();
    this.agentTextBuffer = "";
    this.realtimeToolCalls = [];
    this.endOfCallReport = null;
    this.transfers = [];

    const assistantRuntimeConfig = await this.getAssistantRuntimeConfig();
    const startSpeakingWaitSeconds = Math.max(
      assistantRuntimeConfig?.startSpeakingWaitSeconds ?? 0.4,
      VAPI_MIN_START_SPEAKING_WAIT_SECONDS,
    );

    console.log(
      `    [vapi-call] overrides firstMessageInterruptionsEnabled=false ` +
      `startSpeakingWaitSeconds=${startSpeakingWaitSeconds.toFixed(1)}`
    );

    // Create call via Vapi SDK with WebSocket transport
    const client = new VapiClient({ token: this.config.apiKey });

    const callResponse = await client.calls.create({
      assistantId: this.config.assistantId,
      assistantOverrides: {
        firstMessageInterruptionsEnabled: false,
        startSpeakingPlan: {
          waitSeconds: startSpeakingWaitSeconds,
        },
      },
      transport: {
        provider: "vapi.websocket",
        audioFormat: {
          format: "pcm_s16le",
          container: "raw",
          sampleRate: 16000,
        },
      },
    });
    // SDK returns Call | CallBatchResponse — we always create a single call
    const callData = callResponse as Vapi.Call;

    // Cast to access fields not yet in SDK types
    const rawCall = callData as unknown as Record<string, unknown>;
    this.callId = callData.id;
    this.controlUrl = callData.monitor?.controlUrl ?? null;

    // Capture platform concurrency limits
    const subLimits = rawCall.subscriptionLimits as { concurrencyLimit?: number; concurrencyBlocked?: boolean } | undefined;
    if (subLimits?.concurrencyLimit != null) {
      this.platformConcurrencyLimit = subLimits.concurrencyLimit;
    }
    if (subLimits?.concurrencyBlocked) {
      throw new Error(
        `Vapi concurrency limit reached (${subLimits.concurrencyLimit} concurrent calls). ` +
        `Increase your limit at Vapi Dashboard > Billings & Add-ons.`
      );
    }

    const wsUrl = (callData.transport as Record<string, unknown> | undefined)?.websocketCallUrl as string | undefined;

    if (!wsUrl) {
      throw new Error("Vapi response missing websocketCallUrl");
    }

    // Connect to WebSocket for audio exchange.
    await this.connectWebSocket(wsUrl);
    this._stats.connectLatencyMs = Date.now() - connectStart;

    // Start comfort noise to keep the WebSocket active while waiting for agent greeting
    this.startComfortNoise();
  }

  async sendAudio(pcm: Buffer, opts?: SendAudioOptions): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Vapi WebSocket not connected");
    }
    this._stats.bytesSent += pcm.length;

    // Track when we send audio for component latency calculation
    this.currentTurnIndex++;
    this.turnTimings[this.currentTurnIndex] = { audioSentAt: Date.now() };
    this.awaitingLlmFirstToken = true;
    console.log(
      `    [vapi-send] turn=${this.currentTurnIndex} invoke t=${this.relativeNowMs()}ms ` +
      `pcm24kBytes=${pcm.length} raw=${opts?.raw === true}`
    );

    // Resample 24kHz → 16kHz before sending
    const resampled = resample(pcm, 24000, 16000);
    const raw = opts?.raw ?? false;
    const normalizedResampled = raw
      ? resampled
      : normalizeCallerPcmForVapi(resampled, this.currentTurnIndex, this.relativeNowMs.bind(this));
    if (raw) {
      console.log(
        `    [vapi-send] turn=${this.currentTurnIndex} raw_send t=${this.relativeNowMs()}ms ` +
        `pcm16kBytes=${normalizedResampled.length}`
      );
      this.ws.send(normalizedResampled);
      return;
    }

    // Pace audio at real-time speed: 20ms frames at 16kHz (640 bytes each).
    // Without pacing, Vapi receives seconds of audio instantly and its STT
    // treats it as one continuous utterance, breaking turn-taking.
    const totalFrames = Math.ceil(normalizedResampled.length / VAPI_FRAME_BYTES);
    const turnIdx = this.currentTurnIndex;
    const timing = this.turnTimings[turnIdx]!;
    timing.outboundFrameCount = totalFrames;
    timing.outboundFirstFrameAt = Date.now();

    const audioDurationMs = Math.round((normalizedResampled.length / 2 / 16000) * 1000);
    console.log(
      `    [vapi-send] turn=${turnIdx} paced_start t=${this.relativeNowMs()}ms ` +
      `pcm16kBytes=${normalizedResampled.length} frames=${totalFrames} audioDuration=${audioDurationMs}ms`
    );

    for (let i = 0; i < normalizedResampled.length; i += VAPI_FRAME_BYTES) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
      const end = Math.min(i + VAPI_FRAME_BYTES, normalizedResampled.length);
      this.ws.send(normalizedResampled.subarray(i, end));
      if (i + VAPI_FRAME_BYTES < normalizedResampled.length) {
        await sleep(COMFORT_NOISE_INTERVAL_MS);
      }
    }

    timing.outboundLastFrameAt = Date.now();
    console.log(
      `    [vapi-send] turn=${turnIdx} paced_done t=${this.relativeNowMs()}ms ` +
      `elapsed=${timing.outboundLastFrameAt - timing.outboundFirstFrameAt}ms`
    );

    // Resume comfort noise after speech — keeps WebSocket alive while agent processes
    this.startComfortNoise();
  }

  startComfortNoise(): void {
    if (this.comfortNoiseTimer) return;
    this.comfortNoiseTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopComfortNoise();
        return;
      }
      // Generate low-amplitude random noise at 16kHz
      const frame = Buffer.alloc(COMFORT_NOISE_FRAME_SAMPLES * 2); // 16-bit = 2 bytes per sample
      for (let i = 0; i < COMFORT_NOISE_FRAME_SAMPLES; i++) {
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

  private async pumpOutboundFrames(): Promise<void> {
    try {
      while (this.outboundFrames.length > 0) {
        const frame = this.outboundFrames.shift();
        if (!frame) continue;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
        const timing = this.turnTimings[frame.turnIndex];
        const now = Date.now();
        if (timing && timing.outboundFirstFrameAt == null) {
          timing.outboundFirstFrameAt = now;
          console.log(
            `    [vapi-send] turn=${frame.turnIndex} first_frame t=${this.relativeNowMs()}ms ` +
            `queueRemaining=${this.outboundFrames.length}`
          );
        }
        if (timing) {
          timing.outboundLastFrameAt = now;
        }
        if (frame.frameIndex === frame.totalFrames - 1) {
          console.log(
            `    [vapi-send] turn=${frame.turnIndex} last_frame t=${this.relativeNowMs()}ms ` +
            `frames=${frame.totalFrames}`
          );
        }
        this.ws.send(frame.buffer);
        await sleep(COMFORT_NOISE_INTERVAL_MS);
      }
    } finally {
      this.outboundPumpPromise = null;
      if (this.outboundFrames.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.outboundPumpPromise = this.pumpOutboundFrames();
      }
    }
  }

  /** Consume accumulated real-time agent transcript text (resets buffer). */
  consumeAgentText(): string {
    const text = this.agentTextBuffer;
    this.agentTextBuffer = "";
    if (text) {
      console.log(`    [vapi] consumeAgentText chars=${text.length} text="${summarizeText(text)}"`);
    }
    return text;
  }

  /** Full caller transcript for WER computation (avoids turn alignment issues). */
  getFullCallerTranscript(): string {
    // Prefer real-time WebSocket transcripts: post-call artifact.messages on Vapi
    // can collapse multiple user fragments into one simplified message.
    const realtimeText = this.turnTimings
      .filter(t => t.vapiTranscript)
      .map(t => t.vapiTranscript!)
      .join(" ");
    if (realtimeText) return realtimeText;

    // Fall back to post-call data only if real-time transcripts were unavailable.
    if (this.cachedCallResponse?.artifact?.messages) {
      const text = this.cachedCallResponse.artifact.messages
        .filter(m => m.role === "user" && m.message)
        .map(m => m.message!)
        .join(" ");
      if (text) return text;
    }

    return "";
  }

  async disconnect(): Promise<void> {
    this.stopComfortNoise();
    this.outboundFrames = [];
    this.clearToolCallActive("Call disconnected before tool result arrived", { markPendingFailed: true });
    // End the call on Vapi's side by sending end-call over WebSocket.
    // Per Vapi docs: send {"type": "end-call"} as a text frame to terminate the call cleanly.
    // Also try controlUrl as fallback for cases where WS is already closed.
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "end-call" }));
      } catch {
        // Non-fatal — WS may be closing
      }
    } else if (this.controlUrl) {
      try {
        await fetch(this.controlUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "end-call" }),
        });
      } catch {
        // Non-fatal — call may already be ended
      }
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async getAssistantRuntimeConfig(): Promise<VapiAssistantRuntimeConfig | null> {
    if (this.cachedAssistantRuntimeConfig !== undefined) {
      return this.cachedAssistantRuntimeConfig;
    }

    try {
      const client = new VapiClient({ token: this.config.apiKey });
      const raw = await client.assistants.get({ id: this.config.assistantId }) as unknown as Record<string, unknown>;

      const config = {
        firstMessageMode: raw.firstMessageMode as string | undefined,
        firstMessage: raw.firstMessage as string | undefined,
        maxDurationSeconds: raw.maxDurationSeconds as number | undefined,
        firstMessageInterruptionsEnabled: raw.firstMessageInterruptionsEnabled as boolean | undefined,
        startSpeakingWaitSeconds: (
          (raw.startSpeakingPlan as Record<string, unknown> | undefined)?.waitSeconds as number | undefined
        ),
      };
      this.cachedAssistantRuntimeConfig = config;
      return config;
    } catch {
      this.cachedAssistantRuntimeConfig = null;
      return null;
    }
  }

  async getOpeningSpeaker(): Promise<"agent" | "caller" | null> {
    const config = await this.getAssistantRuntimeConfig();
    if (!config) return null;

    switch (config.firstMessageMode) {
      case "assistant-speaks-first":
      case "assistant-speaks-first-with-model-generated-message":
        return "agent";
      case "assistant-waits-for-user":
      case "user-speaks-first":
        return "caller";
      default:
        return "agent";
    }
  }

  async getExpectedOpeningMessage(): Promise<string | null> {
    const config = await this.getAssistantRuntimeConfig();
    const firstMessage = config?.firstMessage?.trim();
    return firstMessage ? firstMessage : null;
  }

  async getMaxCallDurationSeconds(): Promise<number | null> {
    const config = await this.getAssistantRuntimeConfig();
    return config?.maxDurationSeconds ?? null;
  }

  normalizeCallerTextForSpeech(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return normalized;

    const finalPunctuationMatch = normalized.match(/[.!?]+$/);
    const finalPunctuation = finalPunctuationMatch?.[0] ?? "";
    const source = normalized;
    const sourceFinalPunctuationMatch = source.match(/[.!?]+$/);
    const sourceFinalPunctuation = sourceFinalPunctuationMatch?.[0] ?? finalPunctuation;
    const core = sourceFinalPunctuation
      ? source.slice(0, -sourceFinalPunctuation.length).trim()
      : source;
    const internalSentenceBreaks = core.match(/[.!?]+\s+/g)?.length ?? 0;

    if (internalSentenceBreaks === 0) {
      return source;
    }

    const collapsed = core
      .replace(/[.!?]+\s+/g, ", ")
      .replace(/\s+,/g, ",")
      .replace(/,\s*,+/g, ", ")
      .replace(/\s+/g, " ")
      .trim();

    const terminal = sourceFinalPunctuation.includes("?")
      ? "?"
      : sourceFinalPunctuation.includes("!")
        ? "!"
        : ".";

    return `${collapsed}${terminal}`;
  }

  // ── Post-call data ──────────────────────────────────────────

  /**
   * Resolve post-call messages from the best available source.
   * Prefer a cached end-of-call-report if it already arrived; otherwise poll the API.
   */
  private async getPostCallMessages(): Promise<VapiCallMessage[] | null> {
    if (this.endOfCallReport) {
      const messages = (this.endOfCallReport.artifact as Record<string, unknown> | undefined)?.messages as VapiCallMessage[] | undefined;
      if (messages && messages.length > 0) {
        console.log(`    [vapi-postcall] Got ${messages.length} messages from end-of-call-report`);
        return messages;
      }
      console.log(`    [vapi-postcall] end-of-call-report cached but no artifact.messages; polling API`);
    }

    const data = await this.fetchCallResponse({ requireMessages: true });
    if (data?.artifact?.messages && data.artifact.messages.length > 0) {
      console.log(`    [vapi-postcall] Got ${data.artifact.messages.length} messages from API poll`);
      return data.artifact.messages;
    }
    console.log(`    [vapi-postcall] No messages from API poll either`);
    return null;
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    const messages = await this.getPostCallMessages();
    if (messages) {
      const postCallTools = this.parseToolCalls({ id: "", status: "ended", artifact: { messages } });
      // Only use post-call tools if they have successful matches.
      // If post-call parsing found tool_calls but couldn't match results (all successful=false),
      // prefer real-time captures which have verified successful=true from WebSocket events.
      const anySuccessful = postCallTools.some(tc => tc.successful === true);
      if (postCallTools.length > 0 && anySuccessful) {
        console.log(`    [vapi-postcall] Using ${postCallTools.length} post-call tool calls (${postCallTools.filter(t => t.successful).length} successful)`);
        return postCallTools;
      }
      if (postCallTools.length > 0 && !anySuccessful && this.realtimeToolCalls.length > 0) {
        this.clearToolCallActive("Post-call tool results missing", { markPendingFailed: true });
        console.log(`    [vapi-postcall] Post-call tools found but none matched results; using ${this.realtimeToolCalls.length} real-time tool calls instead`);
        return this.realtimeToolCalls.map((entry) => entry.call);
      }
      if (postCallTools.length > 0) return postCallTools;
    }
    if (this.realtimeToolCalls.length > 0) {
      this.clearToolCallActive("Post-call data unavailable", { markPendingFailed: true });
      console.log(`    [vapi-postcall] No post-call data; using ${this.realtimeToolCalls.length} real-time tool calls`);
    }
    return this.realtimeToolCalls.map((entry) => entry.call);
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    if (this.endOfCallReport) {
      const report = this.endOfCallReport;
      const cb = report.costBreakdown as VapiCallResponse["costBreakdown"] | undefined;
      const analysis = report.analysis as VapiCallResponse["analysis"] | undefined;
      const artifact = report.artifact as VapiCallResponse["artifact"] | undefined;
      return {
        platform: "vapi",
        ended_reason: report.endedReason as string | undefined,
        duration_s: report.duration as number | undefined,
        cost_usd: cb?.total,
        cost_breakdown: cb ? {
          stt_usd: cb.stt,
          llm_usd: cb.llm,
          tts_usd: cb.tts,
          transport_usd: cb.transport,
          platform_usd: cb.vapi,
          total_usd: cb.total,
          llm_prompt_tokens: cb.llmPromptTokens,
          llm_completion_tokens: cb.llmCompletionTokens,
        } : undefined,
        recording_url: getRecordingUrl(artifact?.recording),
        summary: analysis?.summary,
        success_evaluation: analysis?.successEvaluation,
        transfers: this.formatTransfers(),
      };
    }

    const data = await this.fetchCallResponse();
    if (!data) return null;

    const cb = data.costBreakdown;
    return {
      platform: "vapi",
      ended_reason: data.endedReason,
      duration_s: data.duration,
      cost_usd: cb?.total,
      cost_breakdown: cb ? {
        stt_usd: cb.stt,
        llm_usd: cb.llm,
        tts_usd: cb.tts,
        transport_usd: cb.transport,
        platform_usd: cb.vapi,
        total_usd: cb.total,
        llm_prompt_tokens: cb.llmPromptTokens,
        llm_completion_tokens: cb.llmCompletionTokens,
      } : undefined,
      recording_url: getRecordingUrl(data.artifact?.recording),
      summary: data.analysis?.summary,
      success_evaluation: data.analysis?.successEvaluation,
      transfers: this.formatTransfers(),
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return this.turnTimings.map((t) => {
      const stt_ms = t.audioSentAt != null && t.sttDoneAt != null
        && t.sttDoneAt > t.audioSentAt
        ? t.sttDoneAt - t.audioSentAt : undefined;
      const llm_ms = t.sttDoneAt != null && t.llmFirstTokenAt != null
        && t.llmFirstTokenAt > t.sttDoneAt
        ? t.llmFirstTokenAt - t.sttDoneAt : undefined;
      const tts_ms = t.llmFirstTokenAt != null && t.speechStartAt != null
        && t.speechStartAt > t.llmFirstTokenAt
        ? t.speechStartAt - t.llmFirstTokenAt : undefined;
      const speech_duration_ms = t.speechStartAt != null && t.speechStopAt != null
        && t.speechStopAt > t.speechStartAt
        ? t.speechStopAt - t.speechStartAt : undefined;
      return { stt_ms, llm_ms, tts_ms, speech_duration_ms };
    });
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    for (let i = 0; i < this.turnTimings.length; i++) {
      const t = this.turnTimings[i]!;
      if (t.vapiTranscript) {
        transcripts.push({ turnIndex: i, text: t.vapiTranscript });
      }
    }
    return transcripts;
  }

  // ── Private helpers ─────────────────────────────────────────

  private formatTransfers(): CallMetadata["transfers"] {
    if (this.transfers.length === 0) return undefined;
    return this.transfers.map((t) => {
      const dest = (t.detail as Record<string, unknown>).destination as Record<string, unknown> | undefined;
      const destination = dest?.number as string ?? dest?.sipUri as string ?? dest?.assistantName as string;
      return { type: t.type, destination, timestamp_ms: t.timestamp };
    });
  }

  private async fetchCallResponse(
    opts: { requireMessages?: boolean } = {}
  ): Promise<VapiCallResponse | null> {
    if (this.cachedCallResponse && (!opts.requireMessages || this.hasArtifactMessages(this.cachedCallResponse))) {
      return this.cachedCallResponse;
    }
    if (!this.callId) return null;

    // Poll with exponential backoff — Vapi needs time to finalize artifacts after disconnect.
    // Keep the richest ended response we have seen, but do not freeze on the first bare
    // "ended" state if messages are still missing.
    const client = new VapiClient({ token: this.config.apiKey });
    const delays = [500, 1000, 2000, 4000, 8000];
    let bestSeen: VapiCallResponse | null = this.cachedCallResponse;
    for (let i = 0; i < delays.length; i++) {
      await sleep(delays[i]!);
      try {
        const call = await client.calls.get({ id: this.callId });
        const data = call as unknown as VapiCallResponse;
        if (this.isBetterPostCallResponse(data, bestSeen)) {
          bestSeen = data;
        }

        if (opts.requireMessages) {
          if (this.hasArtifactMessages(data)) {
            this.cachedCallResponse = data;
            return data;
          }
          console.log(`    [vapi-postcall] API poll ${i + 1}/${delays.length}: call status=${data.status}, waiting for artifact.messages`);
          continue;
        }

        if (this.hasRichPostCallData(data)) {
          this.cachedCallResponse = data;
          return data;
        }
        console.log(`    [vapi-postcall] API poll ${i + 1}/${delays.length}: call status=${data.status}, no messages yet`);
      } catch (err) {
        console.log(`    [vapi-postcall] API poll ${i + 1}/${delays.length}: ${(err as Error).message}`);
      }
    }

    if (bestSeen) {
      this.cachedCallResponse = bestSeen;
      console.log(`    [vapi-postcall] API poll exhausted — using best available ended response`);
      return bestSeen;
    }
    console.log(`    [vapi-postcall] API poll exhausted after ${delays.length} attempts`);
    return null;
  }

  private hasArtifactMessages(data: VapiCallResponse | null | undefined): boolean {
    return Array.isArray(data?.artifact?.messages) && data!.artifact!.messages!.length > 0;
  }

  private hasRichPostCallData(data: VapiCallResponse | null | undefined): boolean {
    if (!data || data.status !== "ended") return false;
    return this.hasArtifactMessages(data)
      || !!data.analysis?.summary
      || !!data.analysis?.successEvaluation
      || !!data.artifact?.recordingUrl
      || !!data.artifact?.recording
      || !!data.artifact?.transcript;
  }

  private isBetterPostCallResponse(
    candidate: VapiCallResponse,
    current: VapiCallResponse | null
  ): boolean {
    if (!current) return true;
    return this.scorePostCallResponse(candidate) > this.scorePostCallResponse(current);
  }

  private scorePostCallResponse(data: VapiCallResponse): number {
    let score = 0;
    if (data.status === "ended") score += 1;
    if (this.hasArtifactMessages(data)) score += 8;
    if (data.artifact?.transcript) score += 2;
    if (data.artifact?.recordingUrl || data.artifact?.recording) score += 2;
    if (data.analysis?.summary) score += 1;
    if (data.analysis?.successEvaluation) score += 1;
    return score;
  }

  private clearToolCallActive(reason: string, opts: { markPendingFailed?: boolean } = {}): void {
    if (this.toolCallActiveUntil === 0 && this.pendingToolCallIds.size === 0) return;
    const elapsed = this.toolCallStartedAt > 0 ? ` (${Date.now() - this.toolCallStartedAt}ms after tool-calls)` : "";
    console.log(`    [vapi] ${reason}${elapsed} — clearing toolCallActive`);
    if (opts.markPendingFailed) {
      this.markPendingRealtimeToolCalls(false);
    }
    this.toolCallActiveUntil = 0;
    this.toolCallStartedAt = 0;
    this.pendingToolCallIds.clear();
    this.emit("toolCallActive", false);
  }

  private maybeResolveToolCall(msg: Record<string, unknown>): void {
    if (this.toolCallActiveUntil === 0) return;

    const resolvedIds = this.extractResolvedToolCallIds(msg);
    if (resolvedIds.size === 0) return;

    if (resolvedIds.has("__unknown__")) {
      this.markPendingRealtimeToolCalls(true);
      this.clearToolCallActive("Conversation update contains a resolved tool result");
      return;
    }

    if (this.pendingToolCallIds.size === 0) {
      this.markPendingRealtimeToolCalls(true);
      this.clearToolCallActive("Conversation update contains resolved tool result(s)");
      return;
    }

    this.markRealtimeToolCalls(resolvedIds, true);
    for (const id of resolvedIds) {
      this.pendingToolCallIds.delete(id);
    }

    if (this.pendingToolCallIds.size === 0) {
      this.clearToolCallActive("Conversation update contains resolved tool result(s)");
    } else {
      console.log(`    [vapi] Tool results received for ${resolvedIds.size} call(s); still waiting on ${this.pendingToolCallIds.size}`);
    }
  }

  private logConversationUpdate(msg: Record<string, unknown>): void {
    const recent = this.describeRecentMessages(msg);
    console.log(
      `    [vapi] conversation-update pendingTools=${this.pendingToolCallIds.size} recent=${recent.length > 0 ? recent.join(" | ") : "none"}`
    );
  }

  private extractResolvedToolCallIds(msg: Record<string, unknown>): Set<string> {
    const resolved = new Set<string>();
    const artifact = msg.artifact as Record<string, unknown> | undefined;
    const sources = [
      msg.messages,
      artifact?.messages,
      msg.messagesOpenAIFormatted,
      artifact?.messagesOpenAIFormatted,
    ];

    for (const source of sources) {
      if (!Array.isArray(source)) continue;

      for (const entry of source) {
        if (!entry || typeof entry !== "object") continue;
        const message = entry as Record<string, unknown>;
        const role = typeof message.role === "string" ? message.role : "";

        if (role === "tool_call_result") {
          const toolCallId = typeof message.toolCallId === "string"
            ? message.toolCallId
            : typeof message.tool_call_id === "string"
              ? message.tool_call_id
              : "";
          resolved.add(toolCallId || "__unknown__");
          continue;
        }

        if (role === "tool") {
          const content = typeof message.content === "string"
            ? message.content
            : typeof message.result === "string"
              ? message.result
              : "";
          if (!content || content.includes(TOOL_RESULT_PENDING_SENTINEL)) continue;

          const toolCallId = typeof message.tool_call_id === "string"
            ? message.tool_call_id
            : typeof message.toolCallId === "string"
              ? message.toolCallId
              : "";
          resolved.add(toolCallId || "__unknown__");
        }
      }
    }

    return resolved;
  }

  private markRealtimeToolCalls(ids: Iterable<string>, successful: boolean): void {
    const targetIds = new Set(ids);
    for (const entry of this.realtimeToolCalls) {
      if (!entry.id || !targetIds.has(entry.id)) continue;
      entry.call.successful = successful;
    }
  }

  private markPendingRealtimeToolCalls(successful: boolean): void {
    if (this.pendingToolCallIds.size === 0) return;
    this.markRealtimeToolCalls(this.pendingToolCallIds, successful);
  }

  private describeRecentMessages(msg: Record<string, unknown>): string[] {
    const artifact = msg.artifact as Record<string, unknown> | undefined;
    const sources = [artifact?.messages, msg.messages];
    for (const source of sources) {
      if (!Array.isArray(source)) continue;
      return source
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .filter((message) => message.role !== "system")
        .slice(-3)
        .map((message) => describeConversationMessage(message));
    }
    return [];
  }

  private resolveAssistantResponseTurnIndex(
    platformTurn: number | null = this.activeAssistantPlatformTurn,
    createIfMissing = false,
  ): number | null {
    if (isFinitePlatformTurn(platformTurn)) {
      const existing = this.assistantResponseTurnIndexByPlatformTurn.get(platformTurn);
      if (existing != null) return existing;

      if (createIfMissing) {
        const mappedTurnIndex = this.currentTurnIndex;
        this.assistantResponseTurnIndexByPlatformTurn.set(platformTurn, mappedTurnIndex);
        return mappedTurnIndex;
      }
    }

    if (this.activeAssistantResponseTurnIndex != null) return this.activeAssistantResponseTurnIndex;
    if (this.currentTurnIndex >= 0) return this.currentTurnIndex;
    return -1;
  }

  private formatAssistantTurnLabel(turnIndex: number | null, platformTurn: number | null): string {
    const localLabel = turnIndex == null || turnIndex < 0 ? "opening" : String(turnIndex);
    return isFinitePlatformTurn(platformTurn)
      ? `${localLabel}/platform:${platformTurn}`
      : localLabel;
  }

  private async connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "nodebuffer";
      let resolved = false;

      // Timeout if WebSocket doesn't complete handshake
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          reject(new Error(`Vapi WebSocket connection timed out after ${WS_CONNECT_TIMEOUT_MS}ms`));
        }
      }, WS_CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        this.ws = ws;
        console.log(`    [vapi-ws] open t=${this.relativeNowMs()}ms`);

        ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) {
            const chunk = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
            this._stats.bytesReceived += chunk.length;
            const resampled = resample(chunk, 16000, 24000);
            this.emit("audio", resampled);
          } else {
            this.handleControlMessage(data.toString());

            // Resolve on first server message — proves the call is fully provisioned
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve();
            }
          }
        });

        ws.on("error", (err) => {
          this._stats.errorEvents.push(err.message);
          this.emit("error", err);
        });

        ws.on("close", () => {
          this.stopComfortNoise();
          this.ws = null;
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error("Vapi WebSocket closed before call was provisioned"));
            return;
          }
          this.emit("disconnected");
        });
      });

      ws.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Vapi WebSocket connection failed: ${err.message}`));
        }
      });
    });
  }

  private handleControlMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      this._stats.errorEvents.push(`Malformed control message: ${(e as Error).message}`);
      return;
    }

    const type = msg.type as string | undefined;
    if (!type) return;

    const now = Date.now();
    const turn = this.turnTimings[this.currentTurnIndex];

    switch (type) {
      case "transcript": {
        const transcriptType = msg.transcriptType as string | undefined;
        const role = msg.role as string | undefined;
        const transcript = msg.transcript as string | undefined;

        if (transcriptType === "final" && role === "user" && turn) {
          // Final user transcript = STT done for this turn
          turn.sttDoneAt = now;
          if (transcript) {
            turn.vapiTranscript = turn.vapiTranscript
              ? `${turn.vapiTranscript} ${transcript}`.trim()
              : transcript;
          }
        }

        // Capture assistant transcripts for consumeAgentText()
        if (transcriptType === "final" && role === "assistant" && transcript) {
          const assistantTurnIndex = this.resolveAssistantResponseTurnIndex();
          const assistantTurnLabel = this.formatAssistantTurnLabel(assistantTurnIndex, this.activeAssistantPlatformTurn);
          if (assistantTurnIndex == null) {
            console.log(
              `    [vapi] assistant transcript arrived without an active assistant turn ` +
              `chars=${transcript.length} text="${summarizeText(transcript)}"`
            );
            break;
          }
          if (assistantTurnIndex < this.currentTurnIndex) {
            console.log(
              `    [vapi] dropping stale assistant transcript turn=${assistantTurnLabel} ` +
              `currentTurn=${this.currentTurnIndex} chars=${transcript.length} text="${summarizeText(transcript)}"`
            );
            break;
          }
          this.agentTextBuffer += (this.agentTextBuffer ? " " : "") + transcript;
          console.log(`    [vapi] transcript final role=assistant turn=${assistantTurnLabel} chars=${transcript.length} text="${summarizeText(transcript)}"`);
        }
        if (transcriptType === "final" && transcript && role !== "assistant") {
          console.log(`    [vapi] transcript final role=${role ?? "unknown"} turn=${this.currentTurnIndex} chars=${transcript.length} text="${summarizeText(transcript)}"`);
        }
        break;
      }

      case "model-output": {
        // First model output token = LLM started responding
        if (this.awaitingLlmFirstToken && turn) {
          turn.llmFirstTokenAt = now;
          this.awaitingLlmFirstToken = false;
          const turnId = typeof msg.turnId === "string" ? msg.turnId : undefined;
          console.log(`    [vapi] model-output first token turn=${this.currentTurnIndex} turnId=${turnId ?? "n/a"} pendingTools=${this.pendingToolCallIds.size}`);
        }
        break;
      }

      case "speech-update": {
        const status = msg.status as string | undefined;
        const role = msg.role as string | undefined;
        const platformTurn = typeof msg.turn === "number" ? msg.turn : null;
        if (role === "assistant") {
          const assistantTurnIndex = this.resolveAssistantResponseTurnIndex(platformTurn, status === "started");
          const assistantTurn = assistantTurnIndex != null && assistantTurnIndex >= 0
            ? this.turnTimings[assistantTurnIndex]
            : undefined;
          const assistantTurnLabel = this.formatAssistantTurnLabel(assistantTurnIndex, platformTurn);

          if (status === "started") {
            this.activeAssistantPlatformTurn = platformTurn;
            this.activeAssistantResponseTurnIndex = assistantTurnIndex;
            if (assistantTurn) assistantTurn.speechStartAt = now;
            this.emit("platformSpeechStart");
            console.log(
              `    [vapi] speech-update started platformTurn=${platformTurn ?? "n/a"} ` +
              `localTurn=${assistantTurnLabel} pendingTools=${this.pendingToolCallIds.size}`
            );
            if (this.toolCallActiveUntil > 0) {
              if (now >= this.toolCallActiveUntil) {
                this.clearToolCallActive("Tool call safety timeout elapsed", { markPendingFailed: true });
              } else {
                console.log(`    [vapi] Agent speech started during tool call — waiting for tool result (${Math.round((this.toolCallActiveUntil - now) / 1000)}s remaining)`);
              }
            }
          } else if (status === "stopped") {
            if (assistantTurn) assistantTurn.speechStopAt = now;
            console.log(
              `    [vapi] speech-update stopped platformTurn=${platformTurn ?? this.activeAssistantPlatformTurn ?? "n/a"} ` +
              `localTurn=${assistantTurnLabel} pendingTools=${this.pendingToolCallIds.size}`
            );
            if (this.toolCallActiveUntil > 0 && now < this.toolCallActiveUntil) {
              console.log(`    [vapi] Agent speech stopped during tool call`);
            }
          }
        }
        break;
      }

      case "tool-calls": {
        // Real-time tool call events from WebSocket
        const toolCallList = msg.toolCallList as Array<Record<string, unknown>> | undefined;
        if (toolCallList) {
          for (const tc of toolCallList) {
            const fn = tc.function as Record<string, unknown> | undefined;
            if (!fn) continue;
            let args: Record<string, unknown> = {};
            try {
              args = typeof fn.arguments === "string"
                ? JSON.parse(fn.arguments) as Record<string, unknown>
                : (fn.arguments as Record<string, unknown>) ?? {};
            } catch { /* keep empty */ }
            this.realtimeToolCalls.push({
              id: typeof tc.id === "string" ? tc.id : undefined,
              call: {
                name: String(fn.name ?? ""),
                arguments: args,
                timestamp_ms: now - this.connectTimestamp,
              },
            });
          }
          // Signal that the agent is executing a tool — VAD should not fire end-of-turn.
          // Cleared once conversation history includes the real tool result.
          this.toolCallStartedAt = now;
          this.toolCallActiveUntil = now + TOOL_CALL_TIMEOUT_MS;
          this.pendingToolCallIds = new Set(
            toolCallList
              .map((tc) => typeof tc.id === "string" ? tc.id : "")
              .filter(Boolean)
          );
          console.log(`    [vapi] Tool call detected: ${toolCallList.map(tc => (tc.function as Record<string, unknown>)?.name).join(", ")} — suspending VAD until tool result arrives`);
          this.emit("toolCallActive", true);
        }
        break;
      }

      case "status-update": {
        // Call state changes — could be used for diagnostics
        const status = msg.status as string | undefined;
        console.log(`    [vapi] status-update status=${status ?? "unknown"}`);
        if (status === "ended") {
          this.emit("disconnected");
        }
        break;
      }

      case "hang": {
        // Call delay/disconnection event
        this._stats.errorEvents.push(`Vapi hang event: ${JSON.stringify(msg)}`);
        break;
      }

      case "end-of-call-report": {
        // Cache end-of-call report — provides metadata without API polling
        this.endOfCallReport = msg;
        const artifact = msg.artifact as Record<string, unknown> | undefined;
        const messages = artifact?.messages;
        console.log(`    [vapi] end-of-call-report endedReason=${String(msg.endedReason ?? "unknown")} messages=${Array.isArray(messages) ? messages.length : 0}`);
        break;
      }

      case "transfer-destination-request":
      case "transfer-update": {
        this.transfers.push({ type, timestamp: now, detail: msg });
        break;
      }

      case "conversation-update":
        this.logConversationUpdate(msg);
        this.maybeResolveToolCall(msg);
        break;
      case "voice-input":
        // Captured for diagnostics but no action needed
        break;
    }
  }

  private relativeNowMs(): number {
    return this.connectTimestamp > 0 ? Date.now() - this.connectTimestamp : 0;
  }

  private parseToolCalls(data: VapiCallResponse): ObservedToolCall[] {
    const messages = data.artifact?.messages ?? [];
    const toolCalls: ObservedToolCall[] = [];

    // Build a map of tool call results keyed by toolCallId
    // Vapi format: { role: "tool_call_result", toolCallId: "...", result: "..." }
    const resultMap = new Map<string, { result?: string; secondsFromStart?: number }>();
    const resultsByPosition: Array<{ result?: string; secondsFromStart?: number }> = [];
    for (const msg of messages) {
      if (msg.role === "tool_call_result" && msg.toolCallId) {
        const entry = { result: msg.result, secondsFromStart: msg.secondsFromStart };
        resultMap.set(msg.toolCallId, entry);
        resultsByPosition.push(entry);
      }
    }

    let toolCallIndex = 0;
    for (const msg of messages) {
      if ((msg.role === "tool_calls" || msg.role === "tool-call") && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // keep empty
          }

          // Try ID match first, fall back to positional match
          let resultEntry = tc.id ? resultMap.get(tc.id) : undefined;
          if (!resultEntry && toolCallIndex < resultsByPosition.length) {
            console.log(`    [vapi-postcall] Tool call "${tc.function.name}" ID "${tc.id}" not in resultMap (${resultMap.size} entries), using positional match`);
            resultEntry = resultsByPosition[toolCallIndex];
          }

          let parsedResult: unknown;
          try {
            parsedResult = resultEntry?.result ? JSON.parse(resultEntry.result) : undefined;
          } catch {
            parsedResult = resultEntry?.result;
          }

          const timestampMs = msg.secondsFromStart != null ? msg.secondsFromStart * 1000 : undefined;
          const resultTimestampMs = resultEntry?.secondsFromStart != null ? resultEntry.secondsFromStart * 1000 : undefined;
          const hasResult = resultEntry != null;

          toolCalls.push({
            name: tc.function.name,
            arguments: args,
            result: parsedResult,
            successful: hasResult,
            timestamp_ms: timestampMs,
            latency_ms: timestampMs != null && resultTimestampMs != null ? resultTimestampMs - timestampMs : undefined,
          });
          toolCallIndex++;
        }
      }
    }

    return toolCalls;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCallerPcmForVapi(
  pcm16k: Buffer,
  turnIndex: number,
  relativeNowMs: () => number,
): Buffer {
  const frameCount = Math.ceil(pcm16k.length / VAPI_FRAME_BYTES);
  if (frameCount <= 1) return pcm16k;

  const silentFrames: boolean[] = [];
  let firstVoicedFrame = -1;
  let lastVoicedFrame = -1;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const frame = pcm16k.subarray(
      frameIndex * VAPI_FRAME_BYTES,
      Math.min((frameIndex + 1) * VAPI_FRAME_BYTES, pcm16k.length)
    );
    const silent = isEffectivelySilentFrame(frame);
    silentFrames.push(silent);
    if (!silent) {
      if (firstVoicedFrame === -1) firstVoicedFrame = frameIndex;
      lastVoicedFrame = frameIndex;
    }
  }

  if (firstVoicedFrame === -1 || lastVoicedFrame === -1) {
    return pcm16k;
  }

  const normalizedFrames: Buffer[] = [];
  let removedFrames = 0;
  let leadingTrimFrames = firstVoicedFrame;
  let trailingTrimFrames = Math.max(0, frameCount - lastVoicedFrame - 1);
  let longestInternalRunFrames = 0;

  for (let frameIndex = firstVoicedFrame; frameIndex <= lastVoicedFrame; frameIndex++) {
    if (!silentFrames[frameIndex]) {
      normalizedFrames.push(
        pcm16k.subarray(
          frameIndex * VAPI_FRAME_BYTES,
          Math.min((frameIndex + 1) * VAPI_FRAME_BYTES, pcm16k.length)
        )
      );
      continue;
    }

    const runStart = frameIndex;
    while (frameIndex <= lastVoicedFrame && silentFrames[frameIndex]) {
      frameIndex++;
    }
    const runEnd = frameIndex;
    const runLength = runEnd - runStart;
    longestInternalRunFrames = Math.max(longestInternalRunFrames, runLength);
    const keptFrames = Math.min(runLength, VAPI_CALLER_MAX_INTERNAL_SILENCE_FRAMES);

    for (let kept = 0; kept < keptFrames; kept++) {
      const sourceFrameIndex = runStart + kept;
      normalizedFrames.push(
        pcm16k.subarray(
          sourceFrameIndex * VAPI_FRAME_BYTES,
          Math.min((sourceFrameIndex + 1) * VAPI_FRAME_BYTES, pcm16k.length)
        )
      );
    }

    removedFrames += Math.max(0, runLength - keptFrames);
    frameIndex = runEnd - 1;
  }

  if (removedFrames === 0 && leadingTrimFrames === 0 && trailingTrimFrames === 0) {
    return pcm16k;
  }

  const normalized = Buffer.concat(normalizedFrames);
  console.log(
    `    [vapi-send] turn=${turnIndex} silence_normalized t=${relativeNowMs()}ms ` +
    `beforeMs=${Math.round((pcm16k.length / 2 / 16000) * 1000)} ` +
    `afterMs=${Math.round((normalized.length / 2 / 16000) * 1000)} ` +
    `removedFrames=${removedFrames} leadingTrim=${leadingTrimFrames} trailingTrim=${trailingTrimFrames} ` +
    `longestInternalRunMs=${longestInternalRunFrames * COMFORT_NOISE_INTERVAL_MS}`
  );
  return normalized;
}

function isEffectivelySilentFrame(frame: Buffer): boolean {
  for (let offset = 0; offset + 1 < frame.length; offset += 2) {
    const sample = Math.abs(frame.readInt16LE(offset));
    if (sample > VAPI_CALLER_SILENCE_MAX_ABS) {
      return false;
    }
  }
  return true;
}

function isFinitePlatformTurn(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function getRecordingUrl(recording: unknown): string | undefined {
  if (!recording) return undefined;
  if (typeof recording === "string") return recording;
  if (typeof recording !== "object") return undefined;

  const rec = recording as Record<string, unknown>;

  const direct = rec.url;
  if (typeof direct === "string") return direct;

  for (const value of Object.values(rec)) {
    if (typeof value === "string" && /^https?:\/\//.test(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).url;
      if (typeof nested === "string") return nested;
    }
  }

  return undefined;
}

function summarizeText(text: string, maxChars = 96): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function describeConversationMessage(message: Record<string, unknown>): string {
  const role = typeof message.role === "string" ? message.role : "unknown";

  if (role === "tool_calls" || role === "tool-call") {
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const names = toolCalls
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const fn = (entry as Record<string, unknown>).function as Record<string, unknown> | undefined;
        return typeof fn?.name === "string" ? fn.name : "";
      })
      .filter(Boolean);
    return `${role}:${names.join(",") || "unknown"}`;
  }

  if (role === "tool_call_result") {
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "unknown";
    const result = typeof message.result === "string" ? message.result : "";
    return `${role}:${toolCallId}="${summarizeText(result, 64)}"`;
  }

  if (role === "tool") {
    const toolCallId = typeof message.tool_call_id === "string"
      ? message.tool_call_id
      : typeof message.toolCallId === "string"
        ? message.toolCallId
        : "unknown";
    const content = typeof message.content === "string"
      ? message.content
      : typeof message.result === "string"
        ? message.result
        : "";
    return `${role}:${toolCallId}="${summarizeText(content, 64)}"`;
  }

  const text = typeof message.message === "string"
    ? message.message
    : typeof message.content === "string"
      ? message.content
      : "";
  return `${role}="${summarizeText(text, 64)}"`;
}
