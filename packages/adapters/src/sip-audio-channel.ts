/**
 * SIP/Phone Audio Channel (Plivo Audio Streams)
 *
 * Streams bidirectional audio through Plivo Audio Streams over WebSocket.
 * Handles PCM 24kHz <-> mulaw 8kHz conversion internally.
 *
 * Supports two modes:
 *   - outbound (default): Places an outbound call via Plivo to phoneNumber
 *   - inbound: Creates a temporary Plivo Application, assigns it to
 *     fromNumber, then waits for an incoming call from the voice platform
 *
 * Extracted from sip-voice-adapter.ts — no TTS/STT/silence logic.
 */

import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import { pcmToMulaw, mulawToPcm, resample } from "@voiceci/voice";
import type { ObservedToolCall } from "@voiceci/shared";
import { BaseAudioChannel } from "./audio-channel.js";

export interface SipAudioChannelConfig {
  phoneNumber: string;
  fromNumber: string;
  authId: string;
  authToken: string;
  publicHost: string;
  /** "outbound" (default): Plivo dials phoneNumber. "inbound": wait for incoming call on fromNumber. */
  mode?: "inbound" | "outbound";
}

interface PlivoStreamMessage {
  event: string;
  start?: { streamId: string; callId: string };
}

export class SipAudioChannel extends BaseAudioChannel {
  private config: SipAudioChannelConfig;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private mediaWs: WebSocket | null = null;
  private streamId: string | null = null;
  private port = 0;
  private callUuid: string | null = null;
  private toolCalls: ObservedToolCall[] = [];
  private connectTimestamp = 0;
  private appId: string | null = null;

  constructor(config: SipAudioChannelConfig) {
    super();
    this.config = config;
  }

  get connected(): boolean {
    return this.mediaWs !== null;
  }

  get toolCallEndpointUrl(): string | null {
    if (this.port === 0) return null;
    return `https://${this.config.publicHost}:${this.port}/tool-calls`;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    this.connectTimestamp = Date.now();
    this.toolCalls = [];
    await this.startServer();

    console.log(`SIP tool call endpoint: ${this.toolCallEndpointUrl}`);

    if (this.config.mode === "inbound") {
      await this.setupInbound();
    } else {
      await this.placeOutboundCall();
    }

    await this.waitForMediaConnection();
    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  sendAudio(pcm: Buffer): void {
    if (!this.mediaWs) {
      throw new Error("SIP media stream not connected");
    }

    this._stats.bytesSent += pcm.length;
    // PCM 24kHz → 8kHz → mulaw → base64 JSON events
    const pcm8k = resample(pcm, 24000, 8000);
    const mulaw = pcmToMulaw(pcm8k);

    const CHUNK_SIZE = 160; // 20ms at 8kHz mulaw
    for (let offset = 0; offset < mulaw.length; offset += CHUNK_SIZE) {
      const chunk = mulaw.subarray(
        offset,
        Math.min(offset + CHUNK_SIZE, mulaw.length)
      );
      const msg = JSON.stringify({
        event: "playAudio",
        media: {
          contentType: "audio/x-mulaw",
          sampleRate: "8000",
          payload: chunk.toString("base64"),
        },
      });
      this.mediaWs.send(msg);
    }
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    return this.toolCalls;
  }

  async disconnect(): Promise<void> {
    const authHeader = this.plivoAuthHeader();

    if (this.callUuid) {
      await fetch(
        `https://api.plivo.com/v1/Account/${this.config.authId}/Call/${this.callUuid}/`,
        {
          method: "DELETE",
          headers: { Authorization: `Basic ${authHeader}` },
        }
      ).catch(() => {});

      this.callUuid = null;
    }

    if (this.appId) {
      await fetch(
        `https://api.plivo.com/v1/Account/${this.config.authId}/Application/${this.appId}/`,
        {
          method: "DELETE",
          headers: { Authorization: `Basic ${authHeader}` },
        }
      ).catch(() => {});

      this.appId = null;
    }

    if (this.mediaWs) {
      this.mediaWs.close();
      this.mediaWs = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Grace period: keep HTTP server alive for late tool call POSTs
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          server.close();
          resolve();
        }, 5000);
      });
    }
  }

  private async placeOutboundCall(): Promise<void> {
    const answerUrl = `https://${this.config.publicHost}:${this.port}/answer`;
    const authHeader = this.plivoAuthHeader();

    const res = await fetch(
      `https://api.plivo.com/v1/Account/${this.config.authId}/Call/`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: this.config.phoneNumber,
          from: this.config.fromNumber,
          answer_url: answerUrl,
          answer_method: "GET",
        }),
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `Plivo call creation failed (${res.status}): ${errorText}`
      );
    }

    const callData = (await res.json()) as { request_uuid: string };
    this.callUuid = callData.request_uuid;
  }

  private async setupInbound(): Promise<void> {
    const authHeader = this.plivoAuthHeader();
    const answerUrl = `https://${this.config.publicHost}:${this.port}/answer`;

    // Create a temporary Plivo Application with our answer_url
    const appRes = await fetch(
      `https://api.plivo.com/v1/Account/${this.config.authId}/Application/`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          app_name: `voiceci-${Date.now()}`,
          answer_url: answerUrl,
          answer_method: "GET",
        }),
      }
    );

    if (!appRes.ok) {
      const errorText = await appRes.text();
      throw new Error(
        `Plivo application creation failed (${appRes.status}): ${errorText}`
      );
    }

    const appData = (await appRes.json()) as { app_id: string };
    this.appId = appData.app_id;

    // Assign the application to our Plivo number
    const numRes = await fetch(
      `https://api.plivo.com/v1/Account/${this.config.authId}/Number/${this.config.fromNumber}/`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ app_id: this.appId }),
      }
    );

    if (!numRes.ok) {
      const errorText = await numRes.text();
      throw new Error(
        `Plivo number update failed (${numRes.status}): ${errorText}`
      );
    }
  }

  private plivoAuthHeader(): string {
    return Buffer.from(
      `${this.config.authId}:${this.config.authToken}`
    ).toString("base64");
  }

  private async startServer(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.url?.startsWith("/answer")) {
          const wsUrl = `wss://${this.config.publicHost}:${this.port}/stream`;
          const xml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            "<Response>",
            `  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream>`,
            "</Response>",
          ].join("\n");

          res.writeHead(200, { "Content-Type": "application/xml" });
          res.end(xml);
        } else if (req.url?.startsWith("/tool-calls")) {
          if (req.method === "OPTIONS") {
            res.writeHead(204, {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            });
            res.end();
          } else if (req.method === "POST") {
            this.handleToolCallPost(req, res);
          } else {
            res.writeHead(405);
            res.end();
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on("connection", (ws) => {
        this.mediaWs = ws;

        ws.on("message", (data) => {
          let buf: Buffer;
          if (Buffer.isBuffer(data)) {
            buf = data;
          } else if (data instanceof ArrayBuffer) {
            buf = Buffer.from(new Uint8Array(data));
          } else {
            buf = Buffer.concat(data as Buffer[]);
          }

          // JSON control messages (start/stop events)
          if (buf[0] === 0x7b) {
            try {
              const msg = JSON.parse(buf.toString()) as PlivoStreamMessage;
              if (msg.event === "start" && msg.start?.streamId) {
                this.streamId = msg.start.streamId;
              }
            } catch {
              // Ignore
            }
            return;
          }

          // Raw mulaw audio → PCM 24kHz
          this._stats.bytesReceived += buf.length;
          const pcm8k = mulawToPcm(buf);
          const pcm24k = resample(pcm8k, 8000, 24000);
          this.emit("audio", pcm24k);
        });

        ws.on("close", () => {
          this.mediaWs = null;
          this.emit("disconnected");
        });

        ws.on("error", (err) => {
          this._stats.errorEvents.push(err.message);
          this.emit("error", err);
        });
      });

      this.server.listen(0, () => {
        const addr = this.server!.address();
        if (addr && typeof addr !== "string") {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  private handleToolCallPost(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_048_576) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (aborted) return;

      try {
        const parsed = JSON.parse(body) as Record<string, unknown> | Record<string, unknown>[];
        const events = Array.isArray(parsed) ? parsed : [parsed];
        let accepted = 0;

        for (const event of events) {
          if (typeof event.name !== "string" || !event.name) continue;

          this.toolCalls.push({
            name: event.name as string,
            arguments: (event.arguments as Record<string, unknown>) ?? {},
            result: event.result,
            successful: event.successful as boolean | undefined,
            timestamp_ms: Date.now() - this.connectTimestamp,
            latency_ms: event.duration_ms as number | undefined,
          });
          accepted++;
        }

        res.writeHead(201, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ accepted }));
      } catch {
        res.writeHead(400, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  }

  private async waitForMediaConnection(): Promise<void> {
    const maxWait = 30_000;
    const start = Date.now();

    while (!this.mediaWs && Date.now() - start < maxWait) {
      await sleep(500);
    }

    if (!this.mediaWs) {
      throw new Error("Plivo media stream connection timed out");
    }

    while (!this.streamId && Date.now() - start < maxWait) {
      await sleep(200);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
