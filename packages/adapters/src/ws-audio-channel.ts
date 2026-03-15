/**
 * WebSocket Audio Channel
 *
 * Raw bidirectional PCM audio over WebSocket.
 * Supports JSON text frames for tool call events alongside binary audio.
 *
 * Binary frames → audio (PCM 16-bit 24kHz mono)
 * Text frames   → JSON events (tool_call, etc.)
 */

import WebSocket from "ws";
import type { ObservedToolCall } from "@vent/shared";
import { BaseAudioChannel } from "./audio-channel.js";

export interface WsAudioChannelConfig {
  wsUrl: string;
  headers?: Record<string, string>;
}

interface WsToolCallEvent {
  type: "tool_call";
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  duration_ms?: number;
}

export class WsAudioChannel extends BaseAudioChannel {
  private ws: WebSocket | null = null;
  private config: WsAudioChannelConfig;
  private toolCalls: ObservedToolCall[] = [];
  private connectTimestamp = 0;

  constructor(config: WsAudioChannelConfig) {
    super();
    this.config = config;
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

        ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) {
            const chunk =
              data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
            this._stats.bytesReceived += chunk.length;
            this.emit("audio", chunk);
          } else {
            this.handleTextFrame(data.toString());
          }
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
        reject(new Error(`WebSocket connection failed: ${err.message}`));
      });
    });
  }

  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this._stats.bytesSent += pcm.length;
    this.ws.send(pcm);
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    return this.toolCalls;
  }

  private handleTextFrame(text: string): void {
    try {
      const event = JSON.parse(text) as WsToolCallEvent;
      if (event.type === "tool_call" && event.name) {
        this.toolCalls.push({
          name: event.name,
          arguments: event.arguments ?? {},
          result: event.result,
          successful: event.successful,
          timestamp_ms: Date.now() - this.connectTimestamp,
          latency_ms: event.duration_ms,
        });
      }
    } catch {
      // Ignore malformed JSON
    }
  }
}
