/**
 * Vapi Audio Channel
 *
 * Creates a call via Vapi's API with WebSocket transport, exchanges
 * binary PCM audio, and pulls tool call data after the call via GET /call/{id}.
 *
 * Audio format: PCM 16-bit signed little-endian, 16kHz (Vapi's native WS format).
 * Resampling from 24kHz→16kHz on send, 16kHz→24kHz on receive.
 */

import WebSocket from "ws";
import type { ObservedToolCall } from "@vent/shared";
import { resample } from "@vent/voice";
import { BaseAudioChannel } from "./audio-channel.js";

export interface VapiAudioChannelConfig {
  apiKey: string;
  assistantId: string;
}

interface VapiCreateCallResponse {
  id: string;
  transport?: {
    websocketCallUrl?: string;
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
  artifact?: {
    messages?: VapiCallMessage[];
  };
}

export class VapiAudioChannel extends BaseAudioChannel {
  private config: VapiAudioChannelConfig;
  private ws: WebSocket | null = null;
  private callId: string | null = null;

  constructor(config: VapiAudioChannelConfig) {
    super();
    this.config = config;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    // Create call via Vapi API with WebSocket transport
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistantId: this.config.assistantId,
        transport: {
          provider: "vapi.websocket",
          audioFormat: {
            format: "pcm_s16le",
            container: "raw",
            sampleRate: 16000,
          },
        },
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Vapi call creation failed (${res.status}): ${errorText}`);
    }

    const callData = (await res.json()) as VapiCreateCallResponse;
    this.callId = callData.id;
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
    this._stats.bytesSent += pcm.length;
    // Resample 24kHz → 16kHz before sending
    const resampled = resample(pcm, 24000, 16000);
    this.ws.send(resampled);
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    if (!this.callId) return [];

    // Wait briefly for Vapi to process the call data
    await sleep(2000);

    const res = await fetch(`https://api.vapi.ai/call/${this.callId}`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as VapiCallResponse;
    return this.parseToolCalls(data);
  }

  private async connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "nodebuffer";

      ws.on("open", () => {
        this.ws = ws;

        ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) {
            const chunk = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
            this._stats.bytesReceived += chunk.length;
            // Resample 16kHz → 24kHz before emitting
            const resampled = resample(chunk, 16000, 24000);
            this.emit("audio", resampled);
          }
          // Ignore text frames (control messages)
        });

        ws.on("error", (err) => {
          this._stats.errorEvents.push(err.message);
          this.emit("error", err);
        });
        ws.on("close", () => {
          this.ws = null;
          this.emit("disconnected");
        });

        resolve();
      });

      ws.on("error", (err) => {
        reject(new Error(`Vapi WebSocket connection failed: ${err.message}`));
      });
    });
  }

  private parseToolCalls(data: VapiCallResponse): ObservedToolCall[] {
    const messages = data.artifact?.messages ?? [];
    const toolCalls: ObservedToolCall[] = [];

    // Build a map of tool call results keyed by toolCallId
    const resultMap = new Map<string, { result?: string; secondsFromStart?: number }>();
    for (const msg of messages) {
      if (msg.role === "tool_call_result" && msg.results) {
        for (const r of msg.results) {
          if (r.toolCallId) {
            resultMap.set(r.toolCallId, { result: r.result, secondsFromStart: msg.secondsFromStart });
          }
        }
      }
    }

    for (const msg of messages) {
      if (msg.role === "tool_calls" && msg.toolCalls) {
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

          toolCalls.push({
            name: tc.function.name,
            arguments: args,
            result: parsedResult,
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
