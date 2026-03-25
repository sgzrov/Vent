/**
 * SIP/Phone Audio Channel (Twilio Media Streams)
 *
 * Streams bidirectional audio through Twilio Media Streams over WebSocket.
 * Handles PCM 24kHz <-> mulaw 8kHz conversion internally.
 *
 * Supports two modes:
 *   - outbound (default): Places an outbound call via Twilio to phoneNumber
 *   - inbound: Creates a temporary TwiML Application, assigns it to
 *     fromNumber, then waits for an incoming call from the voice platform
 *
 * Extracted from sip-voice-adapter.ts — no TTS/STT/silence logic.
 */

import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import { randomBytes } from "node:crypto";
import Twilio from "twilio";
import { pcmToMulaw, mulawToPcm, resample } from "@vent/voice";
import type { ObservedToolCall } from "@vent/shared";
import { BaseAudioChannel } from "./audio-channel.js";

export interface SipAudioChannelConfig {
  phoneNumber: string;
  fromNumber: string;
  accountSid: string;
  authToken: string;
  publicHost: string;
  /** "outbound" (default): Twilio dials phoneNumber. "inbound": wait for incoming call on fromNumber. */
  mode?: "inbound" | "outbound";
  /** Fixed port for the HTTP server (default: 0 = random OS-assigned). Use a fixed port on Fly.io. */
  port?: number;
  /** Port to include in public URLs. `null` = omit port (standard 443). Default: use actual listen port. */
  publicPort?: number | null;
  /** Extra HTTP routes mounted on the same server (e.g. webhook receivers). */
  additionalRoutes?: Array<{
    path: string;
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  }>;
  /** Called after server + Twilio setup completes, before waiting for media. Use to trigger the inbound call. */
  onReady?: () => Promise<void>;
}

interface TwilioStreamMessage {
  event: string;
  start?: { streamSid: string; callSid: string };
  media?: { payload: string };
  streamSid?: string;
}

export class SipAudioChannel extends BaseAudioChannel {
  private config: SipAudioChannelConfig;
  private twilio: ReturnType<typeof Twilio>;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private mediaWs: WebSocket | null = null;
  private streamSid: string | null = null;
  private port = 0;
  private callSid: string | null = null;
  private toolCalls: ObservedToolCall[] = [];
  private connectTimestamp = 0;
  private appSid: string | null = null;
  private numberSid: string | null = null;
  private originalVoiceUrl: string | null = null;
  private readonly toolCallToken: string;

  constructor(config: SipAudioChannelConfig) {
    super();
    this.config = config;
    this.twilio = Twilio(config.accountSid, config.authToken);
    this.toolCallToken = randomBytes(24).toString("hex");
  }

  get connected(): boolean {
    return this.mediaWs !== null;
  }

  get toolCallEndpointUrl(): string | null {
    if (this.port === 0) return null;
    return `${this.publicBaseUrl("https")}${this.toolCallPath()}`;
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

    if (this.config.onReady) await this.config.onReady();

    await this.waitForMediaConnection();
    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  sendAudio(pcm: Buffer): void {
    if (!this.mediaWs || !this.streamSid) {
      throw new Error("Twilio media stream not connected");
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
        event: "media",
        streamSid: this.streamSid,
        media: {
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
    // Hang up the call
    if (this.callSid) {
      await this.twilio.calls(this.callSid)
        .update({ status: "completed" })
        .catch(() => {});
      this.callSid = null;
    }

    // Delete the temporary TwiML Application
    if (this.appSid) {
      await this.twilio.applications(this.appSid)
        .remove()
        .catch(() => {});
      this.appSid = null;
    }

    // Restore original number config if we changed it
    if (this.numberSid && this.originalVoiceUrl !== null) {
      await this.twilio.incomingPhoneNumbers(this.numberSid)
        .update({ voiceUrl: this.originalVoiceUrl })
        .catch(() => {});
      this.numberSid = null;
      this.originalVoiceUrl = null;
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
    const answerUrl = `${this.publicBaseUrl("https")}/answer`;

    const call = await this.twilio.calls.create({
      to: this.config.phoneNumber,
      from: this.config.fromNumber,
      url: answerUrl,
      method: "GET",
    });

    this.callSid = call.sid;
  }

  private async setupInbound(): Promise<void> {
    const answerUrl = `${this.publicBaseUrl("https")}/answer`;

    // Create a temporary TwiML Application with our answer URL
    const app = await this.twilio.applications.create({
      friendlyName: `vent-${Date.now()}`,
      voiceUrl: answerUrl,
      voiceMethod: "GET",
    });
    this.appSid = app.sid;

    // Look up the phone number SID
    const numbers = await this.twilio.incomingPhoneNumbers.list({
      phoneNumber: this.config.fromNumber,
    });

    if (!numbers.length) {
      throw new Error(
        `Twilio number ${this.config.fromNumber} not found in account`
      );
    }

    this.numberSid = numbers[0].sid;
    this.originalVoiceUrl = numbers[0].voiceUrl ?? "";

    // Assign the TwiML Application to our number
    await this.twilio.incomingPhoneNumbers(this.numberSid).update({
      voiceApplicationSid: this.appSid,
    });
  }

  private async startServer(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const pathname = this.parsePathname(req.url);
        if (req.url?.startsWith("/answer")) {
          const wsUrl = `${this.publicBaseUrl("wss")}/stream`;
          const twiml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            "<Response>",
            `  <Connect><Stream url="${wsUrl}"/></Connect>`,
            "</Response>",
          ].join("\n");

          res.writeHead(200, { "Content-Type": "application/xml" });
          res.end(twiml);
        } else if (pathname === this.toolCallPath()) {
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
          // Check additional routes (e.g. webhook handlers)
          const extra = this.config.additionalRoutes?.find((r) => pathname === r.path);
          if (extra) {
            extra.handler(req, res);
          } else {
            res.writeHead(404);
            res.end();
          }
        }
      });

      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on("connection", (ws) => {
        this.mediaWs = ws;

        ws.on("message", (data) => {
          let raw: string;
          if (Buffer.isBuffer(data)) {
            raw = data.toString();
          } else if (data instanceof ArrayBuffer) {
            raw = Buffer.from(new Uint8Array(data)).toString();
          } else {
            raw = Buffer.concat(data as Buffer[]).toString();
          }

          // Twilio Media Streams sends all messages as JSON
          let msg: TwilioStreamMessage;
          try {
            msg = JSON.parse(raw) as TwilioStreamMessage;
          } catch {
            return;
          }

          if (msg.event === "start" && msg.start?.streamSid) {
            this.streamSid = msg.start.streamSid;
            if (msg.start.callSid) {
              this.callSid = msg.start.callSid;
            }
            return;
          }

          if (msg.event === "media" && msg.media?.payload) {
            const mulaw = Buffer.from(msg.media.payload, "base64");
            this._stats.bytesReceived += mulaw.length;
            const pcm8k = mulawToPcm(mulaw);
            const pcm24k = resample(pcm8k, 8000, 24000);
            this.emit("audio", pcm24k);
            return;
          }

          if (msg.event === "stop") {
            // Call ended
            return;
          }
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

      this.server.listen(this.config.port ?? 0, () => {
        const addr = this.server!.address();
        if (addr && typeof addr !== "string") {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  private publicBaseUrl(scheme: "https" | "wss"): string {
    const pp = this.config.publicPort;
    // publicPort === null → omit port (behind reverse proxy on standard 443)
    if (pp === null) return `${scheme}://${this.config.publicHost}`;
    // publicPort explicitly set → use it
    if (pp !== undefined) return `${scheme}://${this.config.publicHost}:${pp}`;
    // Default (local dev) → use actual bound port
    return `${scheme}://${this.config.publicHost}:${this.port}`;
  }

  private toolCallPath(): string {
    return `/tool-calls/${this.toolCallToken}`;
  }

  private parsePathname(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    try {
      return new URL(rawUrl, "http://127.0.0.1").pathname;
    } catch {
      return null;
    }
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
      throw new Error("Twilio media stream connection timed out");
    }

    while (!this.streamSid && Date.now() - start < maxWait) {
      await sleep(200);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
