/**
 * Retell Audio Channel
 *
 * Composes a SipAudioChannel (inbound mode) for bidirectional audio
 * with Retell's SDK for call creation and post-call data extraction.
 *
 * Flow:
 *   1. connect()  — sets up Twilio inbound, then asks Retell to call us
 *      via SDK createPhoneCall → call_id known immediately
 *   2. sendAudio() / on("audio") — bidirectional PCM 24kHz over SIP
 *   3. disconnect() — hangs up the SIP call
 *   4. getCallData() — fetches tool calls from SDK call.retrieve()
 *   5. getCallMetadata() — cost, latency, recording, analysis
 *   6. getComponentTimings() — STT/LLM/TTS latency with full percentiles
 *   7. getTranscripts() — platform STT transcripts for cross-referencing
 */

import Retell from "retell-sdk";
import type { CallResponse } from "retell-sdk/resources/call.js";
import type { ObservedToolCall, CallMetadata, ComponentLatency, CostBreakdown } from "@vent/shared";
import { BaseAudioChannel } from "./audio-channel.js";
import { SipAudioChannel, type SipAudioChannelConfig } from "./sip-audio-channel.js";

export interface RetellAudioChannelConfig {
  apiKey: string;
  agentId: string;
  sip: SipAudioChannelConfig;
}

export class RetellAudioChannel extends BaseAudioChannel {
  private config: RetellAudioChannelConfig;
  private client: Retell;
  private sipChannel: SipAudioChannel | null = null;
  private callId: string | null = null;
  private cachedCallResponse: CallResponse | null = null;

  constructor(config: RetellAudioChannelConfig) {
    super();
    this.config = config;
    this.client = new Retell({ apiKey: config.apiKey });
  }

  get connected(): boolean {
    return this.sipChannel?.connected ?? false;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    // Start SIP in inbound mode — Twilio app created, number configured, waiting
    this.sipChannel = new SipAudioChannel({ ...this.config.sip, mode: "inbound" });

    this.sipChannel.on("audio", (chunk) => {
      this._stats.bytesReceived += chunk.length;
      this.emit("audio", chunk);
    });
    this.sipChannel.on("error", (err) => {
      this._stats.errorEvents.push(err.message);
      this.emit("error", err);
    });
    this.sipChannel.on("disconnected", () => this.emit("disconnected"));

    // Start the SIP server and configure Twilio number for inbound
    await this.sipChannel.connect();

    // Ask Retell to call our Twilio number — call_id returned immediately
    const call = await this.client.call.createPhoneCall({
      from_number: this.config.sip.phoneNumber,
      to_number: this.config.sip.fromNumber,
    });

    this.callId = call.call_id;
    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  sendAudio(pcm: Buffer): void {
    if (!this.sipChannel) {
      throw new Error("Retell channel not connected");
    }
    this._stats.bytesSent += pcm.length;
    this.sipChannel.sendAudio(pcm);
  }

  async disconnect(): Promise<void> {
    if (this.sipChannel) {
      await this.sipChannel.disconnect();
      this.sipChannel = null;
    }
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchCallResponse();
    if (!data) return [];
    return this.parseToolCalls(data);
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchCallResponse();
    if (!data) return null;

    const cost = data.call_cost as { combined_cost?: number; product_costs?: Array<{ product: string; cost: number }> } | undefined;

    return {
      platform: "retell",
      ended_reason: data.disconnection_reason ?? undefined,
      duration_s: data.duration_ms != null ? data.duration_ms / 1000 : undefined,
      cost_usd: cost?.combined_cost != null ? cost.combined_cost / 100 : undefined,
      cost_breakdown: cost?.product_costs ? buildRetellCostBreakdown(cost.product_costs) : undefined,
      recording_url: data.recording_url ?? undefined,
      summary: data.call_analysis?.call_summary ?? undefined,
      user_sentiment: data.call_analysis?.user_sentiment ?? undefined,
      call_successful: data.call_analysis?.call_successful ?? undefined,
    };
  }

  getComponentTimings(): ComponentLatency[] {
    const data = this.cachedCallResponse;
    if (!data?.latency) return [];

    // Retell provides aggregate latency stats (not per-turn).
    // Return a single entry with p50 values for the executor's component latency report.
    const lat = data.latency as Record<string, { p50?: number; p90?: number; p95?: number; p99?: number } | undefined>;
    return [{
      stt_ms: lat.asr?.p50,
      llm_ms: lat.llm?.p50,
      tts_ms: lat.tts?.p50,
    }];
  }

  /** Full latency percentiles from Retell — richer than ComponentLatency */
  getRetellLatency(): Record<string, { p50?: number; p90?: number; p95?: number; p99?: number }> | null {
    const data = this.cachedCallResponse;
    if (!data?.latency) return null;

    const result: Record<string, { p50?: number; p90?: number; p95?: number; p99?: number }> = {};
    const lat = data.latency as Record<string, { p50?: number; p90?: number; p95?: number; p99?: number } | undefined>;
    for (const key of ["e2e", "asr", "llm", "tts", "knowledge_base", "s2s"]) {
      if (lat[key]) {
        result[key] = {
          p50: lat[key]!.p50,
          p90: lat[key]!.p90,
          p95: lat[key]!.p95,
          p99: lat[key]!.p99,
        };
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const data = this.cachedCallResponse;
    const entries = data?.transcript_with_tool_calls;
    if (!entries) return [];

    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const entry of entries) {
      if (entry.role === "user" && "content" in entry) {
        transcripts.push({ turnIndex: callerTurnIndex, text: entry.content });
        callerTurnIndex++;
      } else if (entry.role === "agent") {
        callerTurnIndex++;
      }
    }
    return transcripts;
  }

  // ── Private helpers ─────────────────────────────────────────

  private async fetchCallResponse(): Promise<CallResponse | null> {
    if (this.cachedCallResponse) return this.cachedCallResponse;
    if (!this.callId) return null;

    // Poll with backoff — Retell needs time to process call data after disconnect
    const delays = [500, 1000, 2000];
    for (const delay of delays) {
      await sleep(delay);
      try {
        const data = await this.client.call.retrieve(this.callId);
        if (data.call_status === "ended" || data.call_status === "error" || data.transcript_with_tool_calls) {
          this.cachedCallResponse = data;
          return data;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private parseToolCalls(data: CallResponse): ObservedToolCall[] {
    const entries = data.transcript_with_tool_calls ?? [];
    const toolCalls: ObservedToolCall[] = [];

    // Build a map of results keyed by tool_call_id
    const resultMap = new Map<string, { content: string; successful?: boolean }>();
    for (const entry of entries) {
      if (entry.role === "tool_call_result") {
        resultMap.set(entry.tool_call_id, { content: entry.content, successful: entry.successful });
      }
    }

    for (const entry of entries) {
      if (entry.role === "tool_call_invocation") {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(entry.arguments) as Record<string, unknown>;
        } catch {
          // keep empty
        }

        const result = resultMap.get(entry.tool_call_id);
        let parsedResult: unknown;
        if (result) {
          try {
            parsedResult = JSON.parse(result.content);
          } catch {
            parsedResult = result.content;
          }
        }

        toolCalls.push({
          name: entry.name,
          arguments: args,
          result: parsedResult,
          successful: result?.successful,
        });
      }
    }

    return toolCalls;
  }
}

function buildRetellCostBreakdown(products: Array<{ product: string; cost: number }>): CostBreakdown {
  const breakdown: CostBreakdown = {};
  let total = 0;
  for (const p of products) {
    const usd = p.cost / 100;
    total += usd;
    const name = p.product.toLowerCase();
    if (name.includes("stt") || name.includes("asr") || name.includes("deepgram") || name.includes("whisper")) {
      breakdown.stt_usd = (breakdown.stt_usd ?? 0) + usd;
    } else if (name.includes("tts") || name.includes("elevenlabs") || name.includes("playht") || name.includes("cartesia")) {
      breakdown.tts_usd = (breakdown.tts_usd ?? 0) + usd;
    } else if (name.includes("llm") || name.includes("gpt") || name.includes("claude") || name.includes("openai")) {
      breakdown.llm_usd = (breakdown.llm_usd ?? 0) + usd;
    } else if (name.includes("transport") || name.includes("telephony") || name.includes("twilio")) {
      breakdown.transport_usd = (breakdown.transport_usd ?? 0) + usd;
    } else if (name.includes("retell") || name.includes("platform")) {
      breakdown.platform_usd = (breakdown.platform_usd ?? 0) + usd;
    }
  }
  breakdown.total_usd = total;
  return breakdown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
