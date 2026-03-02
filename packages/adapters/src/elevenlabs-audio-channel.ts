/**
 * ElevenLabs Conversational AI Audio Channel
 *
 * Connects to ElevenLabs' Conversational AI via WebSocket, exchanges
 * base64-encoded audio, and pulls tool call data after via their REST API.
 *
 * ElevenLabs uses 16kHz PCM audio encoded as base64 in JSON messages.
 * We convert between 24kHz (our standard) and 16kHz (ElevenLabs' format).
 */

import WebSocket from "ws";
import type { ObservedToolCall } from "@voiceci/shared";
import { resample } from "@voiceci/voice";
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

interface ElevenLabsConversationMessage {
  role: string;
  message?: string;
  tool_calls?: Array<{
    name: string;
    params?: Record<string, unknown>;
    tool_call_id?: string;
  }>;
  tool_results?: Array<{
    tool_call_id?: string;
    result?: unknown;
    error?: string;
  }>;
  time_in_call_secs?: number;
}

interface ElevenLabsConversationResponse {
  conversation_id: string;
  status: string;
  transcript?: ElevenLabsConversationMessage[];
}

export class ElevenLabsAudioChannel extends BaseAudioChannel {
  private config: ElevenLabsAudioChannelConfig;
  private ws: WebSocket | null = null;
  private conversationId: string | null = null;

  constructor(config: ElevenLabsAudioChannelConfig) {
    super();
    this.config = config;
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
    if (!this.conversationId) return [];

    // Wait for ElevenLabs to process the conversation data
    await sleep(2000);

    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${this.conversationId}`,
      {
        headers: { "xi-api-key": this.config.apiKey },
      },
    );

    if (!res.ok) return [];

    const data = (await res.json()) as ElevenLabsConversationResponse;
    return this.parseToolCalls(data);
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

  private parseToolCalls(data: ElevenLabsConversationResponse): ObservedToolCall[] {
    const messages = data.transcript ?? [];
    const toolCalls: ObservedToolCall[] = [];

    // Build result map keyed by tool_call_id
    const resultMap = new Map<string, { result?: unknown; error?: string; time?: number }>();
    for (const msg of messages) {
      if (msg.tool_results) {
        for (const tr of msg.tool_results) {
          if (tr.tool_call_id) {
            resultMap.set(tr.tool_call_id, {
              result: tr.result,
              error: tr.error,
              time: msg.time_in_call_secs,
            });
          }
        }
      }
    }

    for (const msg of messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const resultEntry = tc.tool_call_id ? resultMap.get(tc.tool_call_id) : undefined;
          const timestampMs = msg.time_in_call_secs != null ? msg.time_in_call_secs * 1000 : undefined;
          const resultTimeMs = resultEntry?.time != null ? resultEntry.time * 1000 : undefined;

          toolCalls.push({
            name: tc.name,
            arguments: tc.params ?? {},
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
    }

    return toolCalls;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
