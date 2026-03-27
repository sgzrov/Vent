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
import { VapiClient } from "@vapi-ai/server-sdk";
import type { ObservedToolCall, CallMetadata, ComponentLatency } from "@vent/shared";
import { resample } from "@vent/voice";
import { BaseAudioChannel } from "./audio-channel.js";

export interface VapiAudioChannelConfig {
  apiKey: string;
  assistantId: string;
  /** Vapi assistantOverrides — per-call overrides for any assistant field */
  assistantOverrides?: Record<string, unknown>;
}

/** Summarized assistant config pulled from VAPI's API for enriching test reports. */
export interface VapiAssistantConfig {
  name?: string;
  model?: { provider: string; model: string };
  voice?: { provider: string; voiceId?: string };
  transcriber?: { provider: string; model?: string; language?: string };
  tools?: Array<{ type: string; name?: string }>;
  firstMessage?: string;
  serverUrl?: string;
  maxDurationSeconds?: number;
  silenceTimeoutSeconds?: number;
  endCallMessage?: string;
  hipaaEnabled?: boolean;
  backgroundSound?: string;
}

interface VapiCreateCallResponse {
  id: string;
  transport?: {
    websocketCallUrl?: string;
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
  results?: Array<{
    toolCallId?: string;
    result?: string;
  }>;
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
    recordingUrl?: string;
  };
}

/** Per-turn timing from WebSocket text frame events */
interface TurnTiming {
  audioSentAt?: number;
  sttDoneAt?: number;
  llmFirstTokenAt?: number;
  speechStartAt?: number;
  speechStopAt?: number;
  vapiTranscript?: string;
  interrupted?: boolean;
}

/** Comfort noise: 20ms frame at 16kHz = 320 samples = 640 bytes */
const COMFORT_NOISE_FRAME_SAMPLES = 320;
const COMFORT_NOISE_INTERVAL_MS = 20;
const COMFORT_NOISE_AMPLITUDE = 80;

/** WebSocket connect timeout */
const WS_CONNECT_TIMEOUT_MS = 30_000;

export class VapiAudioChannel extends BaseAudioChannel {
  private config: VapiAudioChannelConfig;
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private cachedCallResponse: VapiCallResponse | null = null;

  /** Vapi account concurrency limit, populated after first connect() */
  platformConcurrencyLimit: number | null = null;

  // Component latency tracking from WebSocket text frames
  private turnTimings: TurnTiming[] = [];
  private currentTurnIndex = -1;
  private awaitingLlmFirstToken = false;

  // Real-time tool calls from WebSocket events
  private realtimeToolCalls: ObservedToolCall[] = [];

  // Agent transcript accumulator for consumeAgentText()
  private agentTextBuffer = "";

  // Comfort noise state
  private comfortNoiseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: VapiAudioChannelConfig) {
    super();
    this.config = config;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();

    // Build call creation payload with optional assistantOverrides
    const payload: Record<string, unknown> = {
      assistantId: this.config.assistantId,
      transport: {
        provider: "vapi.websocket",
        audioFormat: {
          format: "pcm_s16le",
          container: "raw",
          sampleRate: 16000,
        },
      },
    };

    if (this.config.assistantOverrides) {
      payload.assistantOverrides = this.config.assistantOverrides;
    }

    // Create call via Vapi API with WebSocket transport
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Vapi call creation failed (${res.status}): ${errorText}`);
    }

    const callData = (await res.json()) as VapiCreateCallResponse;
    this.callId = callData.id;

    // Capture platform concurrency limits
    if (callData.subscriptionLimits?.concurrencyLimit != null) {
      this.platformConcurrencyLimit = callData.subscriptionLimits.concurrencyLimit;
    }
    if (callData.subscriptionLimits?.concurrencyBlocked) {
      throw new Error(
        `Vapi concurrency limit reached (${callData.subscriptionLimits.concurrencyLimit} concurrent calls). ` +
        `Increase your limit at Vapi Dashboard > Billings & Add-ons.`
      );
    }

    const wsUrl = callData.transport?.websocketCallUrl;

    if (!wsUrl) {
      throw new Error("Vapi response missing websocketCallUrl");
    }

    // Connect to WebSocket for audio exchange
    await this.connectWebSocket(wsUrl);
    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Vapi WebSocket not connected");
    }
    this.stopComfortNoise();
    this._stats.bytesSent += pcm.length;

    // Track when we send audio for component latency calculation
    this.currentTurnIndex++;
    this.turnTimings[this.currentTurnIndex] = { audioSentAt: Date.now() };
    this.awaitingLlmFirstToken = true;

    // Resample 24kHz → 16kHz before sending
    const resampled = resample(pcm, 24000, 16000);
    this.ws.send(resampled);
  }

  async sendAudioStream(stream: AsyncIterable<Buffer>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Vapi WebSocket not connected");
    }
    this.stopComfortNoise();

    // Track when we send audio for component latency calculation
    this.currentTurnIndex++;
    this.turnTimings[this.currentTurnIndex] = { audioSentAt: Date.now() };
    this.awaitingLlmFirstToken = true;

    for await (const chunk of stream) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
      this._stats.bytesSent += chunk.length;
      const resampled = resample(chunk, 24000, 16000);
      this.ws.send(resampled);
    }
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

  /** Consume accumulated real-time agent transcript text (resets buffer). */
  consumeAgentText(): string {
    const text = this.agentTextBuffer;
    this.agentTextBuffer = "";
    return text;
  }

  async disconnect(): Promise<void> {
    this.stopComfortNoise();
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async getAssistantConfig(): Promise<VapiAssistantConfig | null> {
    try {
      const client = new VapiClient({ token: this.config.apiKey });
      const raw = await client.assistants.get({ id: this.config.assistantId }) as unknown as Record<string, unknown>;

      const model = raw.model as Record<string, unknown> | undefined;
      const voice = raw.voice as Record<string, unknown> | undefined;
      const transcriber = raw.transcriber as Record<string, unknown> | undefined;
      const modelTools = model?.tools as Array<Record<string, unknown>> | undefined;
      const compliancePlan = raw.compliancePlan as Record<string, unknown> | undefined;
      const server = raw.server as Record<string, unknown> | undefined;

      return {
        name: raw.name as string | undefined,
        model: model ? { provider: String(model.provider ?? ""), model: String(model.model ?? "") } : undefined,
        voice: voice ? { provider: String(voice.provider ?? ""), voiceId: voice.voiceId as string | undefined } : undefined,
        transcriber: transcriber
          ? { provider: String(transcriber.provider ?? ""), model: transcriber.model as string | undefined, language: transcriber.language as string | undefined }
          : undefined,
        tools: modelTools?.map((t) => ({ type: String(t.type ?? ""), name: (t.function as Record<string, unknown>)?.name as string | undefined })),
        firstMessage: raw.firstMessage as string | undefined,
        serverUrl: server?.url as string | undefined,
        maxDurationSeconds: raw.maxDurationSeconds as number | undefined,
        endCallMessage: raw.endCallMessage as string | undefined,
        hipaaEnabled: compliancePlan?.hipaaEnabled as boolean | undefined,
        backgroundSound: raw.backgroundSound as string | undefined,
      };
    } catch {
      return null;
    }
  }

  // ── Post-call data (both use cached fetch) ──────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchCallResponse();
    if (!data) return this.realtimeToolCalls;
    // Merge post-call tool calls with any real-time ones we captured
    const postCallTools = this.parseToolCalls(data);
    return postCallTools.length > 0 ? postCallTools : this.realtimeToolCalls;
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
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
      recording_url: data.artifact?.recordingUrl,
      summary: data.analysis?.summary,
      success_evaluation: data.analysis?.successEvaluation,
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return this.turnTimings.map((t) => {
      const stt_ms = t.audioSentAt != null && t.sttDoneAt != null
        ? t.sttDoneAt - t.audioSentAt : undefined;
      const llm_ms = t.sttDoneAt != null && t.llmFirstTokenAt != null
        ? t.llmFirstTokenAt - t.sttDoneAt : undefined;
      const tts_ms = t.llmFirstTokenAt != null && t.speechStartAt != null
        ? t.speechStartAt - t.llmFirstTokenAt : undefined;
      const speech_duration_ms = t.speechStartAt != null && t.speechStopAt != null
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

  private async fetchCallResponse(): Promise<VapiCallResponse | null> {
    if (this.cachedCallResponse) return this.cachedCallResponse;
    if (!this.callId) return null;

    // Poll with exponential backoff — Vapi needs time to process call data after disconnect
    const delays = [500, 1000, 2000, 4000, 8000];
    for (const delay of delays) {
      await sleep(delay);
      try {
        const res = await fetch(`https://api.vapi.ai/call/${this.callId}`, {
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
        });
        if (!res.ok) continue;

        const data = (await res.json()) as VapiCallResponse;
        // Check if call data is ready (has artifact with messages or ended status)
        if (data.artifact?.messages || data.status === "ended") {
          this.cachedCallResponse = data;
          return data;
        }
      } catch {
        // Network error — retry on next delay
      }
    }

    return null;
  }

  private pingTimer: ReturnType<typeof setInterval> | null = null;

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

        // Send WebSocket-level pings every 5s — Vapi expects keepalive frames
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 5000);

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
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
          }
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
          if (transcript) turn.vapiTranscript = transcript;
        }

        // Capture assistant transcripts for consumeAgentText()
        if (transcriptType === "final" && role === "assistant" && transcript) {
          this.agentTextBuffer += (this.agentTextBuffer ? " " : "") + transcript;
        }
        break;
      }

      case "model-output": {
        // First model output token = LLM started responding
        if (this.awaitingLlmFirstToken && turn) {
          turn.llmFirstTokenAt = now;
          this.awaitingLlmFirstToken = false;
        }
        break;
      }

      case "speech-update": {
        const status = msg.status as string | undefined;
        const role = msg.role as string | undefined;
        if (role === "assistant" && turn) {
          if (status === "started") {
            turn.speechStartAt = now;
          } else if (status === "stopped") {
            turn.speechStopAt = now;
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
              name: String(fn.name ?? ""),
              arguments: args,
              timestamp_ms: now,
            });
          }
        }
        break;
      }

      case "user-interrupted": {
        // Track that user interrupted the assistant on this turn
        if (turn) turn.interrupted = true;
        break;
      }

      case "status-update": {
        // Call state changes — could be used for diagnostics
        const status = msg.status as string | undefined;
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
    }
  }

  private parseToolCalls(data: VapiCallResponse): ObservedToolCall[] {
    const messages = data.artifact?.messages ?? [];
    const toolCalls: ObservedToolCall[] = [];

    // Build a map of tool call results keyed by toolCallId
    // Support both underscore (tool_call_result) and hyphen (tool-call-result) role formats
    const resultMap = new Map<string, { result?: string; secondsFromStart?: number }>();
    for (const msg of messages) {
      if ((msg.role === "tool_call_result" || msg.role === "tool-call-result") && msg.results) {
        for (const r of msg.results) {
          if (r.toolCallId) {
            resultMap.set(r.toolCallId, { result: r.result, secondsFromStart: msg.secondsFromStart });
          }
        }
      }
    }

    for (const msg of messages) {
      if ((msg.role === "tool_calls" || msg.role === "tool-call") && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // keep empty
          }

          const resultEntry = tc.id ? resultMap.get(tc.id) : undefined;
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
            successful: hasResult ? true : undefined,
            timestamp_ms: timestampMs,
            latency_ms: timestampMs != null && resultTimestampMs != null ? resultTimestampMs - timestampMs : undefined,
          });
        }
      }
    }

    return toolCalls;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
