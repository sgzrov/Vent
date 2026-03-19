/**
 * ElevenLabs Conversational AI Audio Channel
 *
 * Connects to ElevenLabs' Conversational AI via WebSocket, exchanges
 * base64-encoded audio, and pulls tool call data after via their SDK.
 *
 * ElevenLabs uses 16kHz PCM audio encoded as base64 in JSON messages.
 * We convert between 24kHz (our standard) and 16kHz (ElevenLabs' format).
 *
 * Post-call data (tool calls, metadata, latency) fetched via SDK
 * client.conversationalAi.conversations.get().
 */

import WebSocket from "ws";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { ObservedToolCall, CallMetadata, ComponentLatency, CostBreakdown } from "@vent/shared";
import { resample } from "@vent/voice";
import { BaseAudioChannel } from "./audio-channel.js";

export interface ElevenLabsAudioChannelConfig {
  apiKey: string;
  agentId: string;
}

interface ElevenLabsServerMessage {
  type: string;
  conversation_id?: string;
  audio?: {
    chunk?: string; // base64
    sample_rate?: number;
  };
  agent_output_audio_format?: string;
  user_input_audio_format?: string;
}

export class ElevenLabsAudioChannel extends BaseAudioChannel {
  private config: ElevenLabsAudioChannelConfig;
  private client: ElevenLabsClient;
  private ws: WebSocket | null = null;
  private conversationId: string | null = null;
  private cachedConversation: Record<string, unknown> | null = null;

  constructor(config: ElevenLabsAudioChannelConfig) {
    super();
    this.config = config;
    this.client = new ElevenLabsClient({ apiKey: config.apiKey });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${this.config.agentId}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          "xi-api-key": this.config.apiKey,
        },
      });

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("ElevenLabs WebSocket connection timed out"));
      }, 30_000);

      ws.on("open", () => {
        this.ws = ws;

        // Send conversation initiation
        ws.send(JSON.stringify({
          type: "conversation_initiation_client_data",
          conversation_config_override: {},
        }));

        ws.on("message", (data: WebSocket.RawData) => {
          const text = data.toString();
          try {
            const msg = JSON.parse(text) as ElevenLabsServerMessage;
            this.handleServerMessage(msg);

            // Resolve once we get the conversation metadata
            if (msg.type === "conversation_initiation_metadata" && msg.conversation_id) {
              this.conversationId = msg.conversation_id;
              this._stats.connectLatencyMs = Date.now() - connectStart;
              clearTimeout(timeout);
              resolve();
            }
          } catch {
            // Ignore malformed messages
          }
        });

        ws.on("error", (err) => {
          clearTimeout(timeout);
          this._stats.errorEvents.push(err.message);
          this.emit("error", err);
        });

        ws.on("close", () => {
          this.ws = null;
          this.emit("disconnected");
        });
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`ElevenLabs WebSocket connection failed: ${err.message}`));
      });
    });
  }

  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("ElevenLabs WebSocket not connected");
    }

    this._stats.bytesSent += pcm.length;
    // Resample 24kHz → 16kHz, then base64 encode
    const pcm16k = resample(pcm, 24000, 16000);
    const base64Audio = pcm16k.toString("base64");

    this.ws.send(JSON.stringify({
      user_audio_chunk: base64Audio,
    }));
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchConversation();
    if (!data) return [];
    return this.parseToolCalls(data);
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchConversation();
    if (!data) return null;

    const meta = data.metadata as Record<string, unknown> | undefined;
    const charging = meta?.charging as Record<string, unknown> | undefined;
    const analysis = data.analysis as Record<string, unknown> | undefined;

    // ElevenLabs cost unit is undocumented — llm_price appears to be USD,
    // call_charge unit is unclear. Pass through what we can.
    const costBreakdown: CostBreakdown | undefined = charging ? {
      llm_usd: charging.llmPrice as number | undefined,
    } : undefined;

    const callSuccessful = analysis?.callSuccessful as string | undefined;

    return {
      platform: "elevenlabs",
      ended_reason: meta?.terminationReason as string | undefined,
      duration_s: meta?.callDurationSecs as number | undefined,
      cost_breakdown: costBreakdown,
      summary: analysis?.transcriptSummary as string | undefined,
      call_successful: callSuccessful === "success" ? true
        : callSuccessful === "failure" ? false : undefined,
    };
  }

  getComponentTimings(): ComponentLatency[] {
    const data = this.cachedConversation;
    const transcript = data?.transcript as Array<Record<string, unknown>> | undefined;
    if (!transcript) return [];

    const timings: ComponentLatency[] = [];
    for (const msg of transcript) {
      if (msg.role !== "agent") continue;
      const turnMetrics = msg.conversationTurnMetrics as Record<string, unknown> | undefined;
      const metrics = turnMetrics?.metrics as Record<string, { elapsedTime?: number }> | undefined;
      if (!metrics) continue;

      // ElevenLabs metric keys are free-form (e.g. "convai_llm_service_ttfb").
      // Match by substring to handle varying key names.
      let llmMs: number | undefined;
      for (const [key, val] of Object.entries(metrics)) {
        if (key.includes("llm") && key.includes("ttfb") && val.elapsedTime != null) {
          llmMs = val.elapsedTime * 1000;
        }
      }

      if (llmMs != null) {
        timings.push({ llm_ms: llmMs });
      }
    }
    return timings;
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const data = this.cachedConversation;
    const transcript = data?.transcript as Array<Record<string, unknown>> | undefined;
    if (!transcript) return [];

    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const msg of transcript) {
      if (msg.role === "user" && typeof msg.message === "string") {
        transcripts.push({ turnIndex: callerTurnIndex, text: msg.message });
        callerTurnIndex++;
      } else if (msg.role === "agent") {
        callerTurnIndex++;
      }
    }
    return transcripts;
  }

  // ── Private helpers ─────────────────────────────────────────

  private async fetchConversation(): Promise<Record<string, unknown> | null> {
    if (this.cachedConversation) return this.cachedConversation;
    if (!this.conversationId) return null;

    // Poll with backoff — ElevenLabs transitions through "processing" before "done"
    const delays = [500, 1000, 2000];
    for (const delay of delays) {
      await sleep(delay);
      try {
        const data = await this.client.conversationalAi.conversations.get(this.conversationId) as unknown as Record<string, unknown>;
        const status = data.status as string | undefined;
        const transcript = data.transcript as unknown[] | undefined;
        if (status === "done" || status === "failed" || (transcript && transcript.length > 0)) {
          this.cachedConversation = data;
          return data;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private handleServerMessage(msg: ElevenLabsServerMessage): void {
    if (msg.type === "audio" && msg.audio?.chunk) {
      // Decode base64 audio and resample 16kHz → 24kHz
      const pcm16k = Buffer.from(msg.audio.chunk, "base64");
      this._stats.bytesReceived += pcm16k.length;
      const pcm24k = resample(pcm16k, 16000, 24000);
      this.emit("audio", pcm24k);
    }
  }

  private parseToolCalls(data: Record<string, unknown>): ObservedToolCall[] {
    const messages = data.transcript as Array<Record<string, unknown>> | undefined;
    if (!messages) return [];

    const toolCalls: ObservedToolCall[] = [];

    // Build result map keyed by tool_call_id
    const resultMap = new Map<string, { result?: unknown; error?: string; time?: number }>();
    for (const msg of messages) {
      const toolResults = msg.toolResults as Array<Record<string, unknown>> | undefined;
      if (toolResults) {
        for (const tr of toolResults) {
          const id = tr.toolCallId as string | undefined;
          if (id) {
            resultMap.set(id, {
              result: tr.result,
              error: tr.error as string | undefined,
              time: msg.timeInCallSecs as number | undefined,
            });
          }
        }
      }
    }

    for (const msg of messages) {
      const tcs = msg.toolCalls as Array<Record<string, unknown>> | undefined;
      if (!tcs) continue;

      for (const tc of tcs) {
        const name = tc.name as string;
        const params = tc.params as Record<string, unknown> | undefined;
        const toolCallId = tc.toolCallId as string | undefined;
        const resultEntry = toolCallId ? resultMap.get(toolCallId) : undefined;
        const timestampMs = msg.timeInCallSecs != null ? (msg.timeInCallSecs as number) * 1000 : undefined;
        const resultTimeMs = resultEntry?.time != null ? resultEntry.time * 1000 : undefined;

        toolCalls.push({
          name,
          arguments: params ?? {},
          result: resultEntry?.result,
          successful: resultEntry ? !resultEntry.error : undefined,
          timestamp_ms: timestampMs,
          latency_ms:
            timestampMs != null && resultTimeMs != null
              ? resultTimeMs - timestampMs
              : undefined,
        });
      }
    }

    return toolCalls;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
