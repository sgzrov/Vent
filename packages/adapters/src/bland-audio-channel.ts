/**
 * Bland AI Audio Channel
 *
 * Composes a SipAudioChannel (inbound mode) for bidirectional audio
 * with Bland's REST API for call creation and tool call extraction.
 *
 * Flow:
 *   1. connect()  — fetches agent config from GET /v1/inbound/{phone},
 *      sets up Twilio inbound, then asks Bland to call us via POST /v1/calls
 *      → call_id known immediately
 *   2. sendAudio() / on("audio") — bidirectional PCM 24kHz over SIP
 *   3. disconnect() — hangs up the SIP call
 *   4. getCallData() — fetches tool calls from GET /v1/calls/{call_id}
 */

import type { ObservedToolCall, CallMetadata } from "@vent/shared";
import { BaseAudioChannel } from "./audio-channel.js";
import { SipAudioChannel, type SipAudioChannelConfig } from "./sip-audio-channel.js";

export interface BlandAudioChannelConfig {
  apiKey: string;
  phoneNumber: string;
  sip: SipAudioChannelConfig;
}

interface BlandTranscriptEntry {
  id: string;
  created_at: string;
  text: string;
  user: "user" | "assistant" | "robot" | "agent-action";
}

interface BlandCallResponse {
  call_id: string;
  status: string;
  completed?: boolean;
  transcripts?: BlandTranscriptEntry[];
  concatenated_transcript?: string;
  variables?: Record<string, unknown>;
  pathway_logs?: Array<{
    node_id?: string;
    text?: string;
    data?: Record<string, unknown>;
  }>;
  call_length?: number; // minutes (decimal)
  corrected_duration?: string; // seconds as string
  price?: number; // USD
  recording_url?: string;
  summary?: string;
  answered_by?: string;
  call_ended_by?: string;
  error_message?: string;
}

interface BlandInboundConfig {
  pathway_id?: string;
  prompt?: string;
  voice_id?: number;
  max_duration?: number;
}

interface BlandSendCallResponse {
  status: string;
  call_id: string;
}

export class BlandAudioChannel extends BaseAudioChannel {
  private config: BlandAudioChannelConfig;
  private sipChannel: SipAudioChannel | null = null;
  private callId: string | null = null;
  private cachedCallResponse: BlandCallResponse | null = null;

  constructor(config: BlandAudioChannelConfig) {
    super();
    this.config = config;
  }

  get connected(): boolean {
    return this.sipChannel?.connected ?? false;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    // Fetch agent config from Bland's inbound number
    const agentConfig = await this.fetchInboundConfig();

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

    await this.sipChannel.connect();

    // Ask Bland to call our Twilio number — call_id returned immediately
    const callBody: Record<string, unknown> = {
      phone_number: this.config.sip.fromNumber,
    };

    // Use pathway_id if available, otherwise fall back to task (prompt)
    if (agentConfig.pathway_id) {
      callBody.pathway_id = agentConfig.pathway_id;
    } else if (agentConfig.prompt) {
      callBody.task = agentConfig.prompt;
    }

    const res = await fetch("https://api.bland.ai/v1/calls", {
      method: "POST",
      headers: {
        authorization: this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(callBody),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Bland send-call failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as BlandSendCallResponse;
    this.callId = data.call_id;
    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  sendAudio(pcm: Buffer): void {
    if (!this.sipChannel) {
      throw new Error("Bland channel not connected");
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

    const durationS = data.corrected_duration != null
      ? parseFloat(data.corrected_duration)
      : data.call_length != null ? data.call_length * 60 : undefined;

    // Determine ended_reason from available fields
    let endedReason = data.status;
    if (data.call_ended_by) endedReason = `ended_by_${data.call_ended_by.toLowerCase()}`;
    if (data.error_message) endedReason = `error: ${data.error_message}`;

    return {
      platform: "bland",
      ended_reason: endedReason,
      duration_s: durationS,
      cost_usd: data.price,
      recording_url: data.recording_url,
      summary: data.summary,
    };
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const data = this.cachedCallResponse;
    if (!data?.transcripts) return [];

    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const entry of data.transcripts) {
      if (entry.user === "user") {
        transcripts.push({ turnIndex: callerTurnIndex, text: entry.text });
        callerTurnIndex++;
      } else if (entry.user === "assistant" || entry.user === "robot") {
        callerTurnIndex++;
      }
    }
    return transcripts;
  }

  // ── Private helpers ─────────────────────────────────────────

  private async fetchCallResponse(): Promise<BlandCallResponse | null> {
    if (this.cachedCallResponse) return this.cachedCallResponse;
    if (!this.callId) return null;

    // Poll with backoff — Bland needs time to process call data after disconnect
    const delays = [500, 1000, 2000, 3000];
    for (const delay of delays) {
      await sleep(delay);
      const res = await fetch(`https://api.bland.ai/v1/calls/${this.callId}`, {
        headers: { authorization: this.config.apiKey },
      });
      if (!res.ok) continue;

      const data = (await res.json()) as BlandCallResponse;
      if (data.completed || data.status === "completed" || data.status === "failed") {
        this.cachedCallResponse = data;
        return data;
      }
    }

    return null;
  }

  private async fetchInboundConfig(): Promise<BlandInboundConfig> {
    const res = await fetch(
      `https://api.bland.ai/v1/inbound/${encodeURIComponent(this.config.phoneNumber)}`,
      { headers: { authorization: this.config.apiKey } },
    );

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `Bland get-inbound-number failed (${res.status}): ${errorText}`
      );
    }

    return (await res.json()) as BlandInboundConfig;
  }

  private parseToolCalls(data: BlandCallResponse): ObservedToolCall[] {
    const toolCalls: ObservedToolCall[] = [];

    // Extract tool calls from transcript entries with user type "agent-action"
    const transcripts = data.transcripts ?? [];
    for (const entry of transcripts) {
      if (entry.user === "agent-action") {
        // Bland agent-action entries contain tool invocation info in the text
        // Try to parse as JSON, fall back to using text as the tool name
        try {
          const parsed = JSON.parse(entry.text) as {
            name?: string;
            tool?: string;
            arguments?: Record<string, unknown>;
            result?: unknown;
          };
          toolCalls.push({
            name: parsed.name ?? parsed.tool ?? "unknown",
            arguments: parsed.arguments ?? {},
            result: parsed.result,
            timestamp_ms: new Date(entry.created_at).getTime(),
          });
        } catch {
          toolCalls.push({
            name: entry.text,
            arguments: {},
            timestamp_ms: new Date(entry.created_at).getTime(),
          });
        }
      }
    }

    // Also check pathway_logs for tool invocations
    const pathwayLogs = data.pathway_logs ?? [];
    for (const log of pathwayLogs) {
      if (log.data && (log.data.tool_name || log.data.function_name)) {
        const name = (log.data.tool_name ?? log.data.function_name) as string;
        toolCalls.push({
          name,
          arguments: (log.data.arguments ?? {}) as Record<string, unknown>,
          result: log.data.result,
        });
      }
    }

    return toolCalls;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
