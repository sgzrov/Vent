/**
 * Retell Audio Channel
 *
 * Composes a SipAudioChannel (inbound mode) for bidirectional audio
 * with Retell's REST API for call creation and tool call extraction.
 *
 * Flow:
 *   1. connect()  — sets up Plivo inbound, then asks Retell to call us
 *      via POST /v2/create-phone-call → call_id known immediately
 *   2. sendAudio() / on("audio") — bidirectional PCM 24kHz over SIP
 *   3. disconnect() — hangs up the SIP call
 *   4. getCallData() — fetches tool calls from GET /v2/get-call/{call_id}
 */

import type { ObservedToolCall } from "@voiceci/shared";
import { BaseAudioChannel } from "./audio-channel.js";
import { SipAudioChannel, type SipAudioChannelConfig } from "./sip-audio-channel.js";

export interface RetellAudioChannelConfig {
  apiKey: string;
  agentId: string;
  sip: SipAudioChannelConfig;
}

interface RetellToolCallInvocation {
  role: "tool_call_invocation";
  tool_call_id: string;
  name: string;
  arguments: string;
}

interface RetellToolCallResult {
  role: "tool_call_result";
  tool_call_id: string;
  content: string;
  successful: boolean;
}

interface RetellUtterance {
  role: "agent" | "user";
  content: string;
  words?: Array<{ word: string; start: number; end: number }>;
}

type RetellTranscriptEntry =
  | RetellUtterance
  | RetellToolCallInvocation
  | RetellToolCallResult;

interface RetellCallResponse {
  call_id: string;
  call_status: string;
  transcript_with_tool_calls?: RetellTranscriptEntry[];
  start_timestamp?: number;
  end_timestamp?: number;
}

interface RetellCreateCallResponse {
  call_id: string;
  call_status: string;
}

export class RetellAudioChannel extends BaseAudioChannel {
  private config: RetellAudioChannelConfig;
  private sipChannel: SipAudioChannel | null = null;
  private callId: string | null = null;

  constructor(config: RetellAudioChannelConfig) {
    super();
    this.config = config;
  }

  get connected(): boolean {
    return this.sipChannel?.connected ?? false;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    // Start SIP in inbound mode — Plivo app created, number configured, waiting
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

    // Start the SIP server and configure Plivo number for inbound
    await this.sipChannel.connect();

    // Ask Retell to call our Plivo number — call_id returned immediately
    const res = await fetch("https://api.retellai.com/v2/create-phone-call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from_number: this.config.sip.phoneNumber,
        to_number: this.config.sip.fromNumber,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Retell create-phone-call failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as RetellCreateCallResponse;
    this.callId = data.call_id;
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
    if (!this.callId) return [];

    // Wait for Retell to process the call data
    await sleep(2000);

    const res = await fetch(`https://api.retellai.com/v2/get-call/${this.callId}`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as RetellCallResponse;
    return this.parseToolCalls(data);
  }

  private parseToolCalls(data: RetellCallResponse): ObservedToolCall[] {
    const entries = data.transcript_with_tool_calls ?? [];
    const toolCalls: ObservedToolCall[] = [];

    // Build a map of results keyed by tool_call_id
    const resultMap = new Map<string, RetellToolCallResult>();
    for (const entry of entries) {
      if (entry.role === "tool_call_result") {
        resultMap.set(entry.tool_call_id, entry);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
