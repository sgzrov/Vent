/**
 * Bland AI Audio Channel
 *
 * Uses POST /v1/calls + SIP inbound via SharedSipServer.
 * Bland dials our Twilio number — real audio over SIP, call_id upfront,
 * webhook events for component latency, concurrent testing support.
 *
 * Post-call data is fetched from GET /v1/calls/{call_id}.
 */

import http from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { pcmToMulaw, mulawToPcm, resample } from "@vent/voice";
import type { ObservedToolCall, CallMetadata, ComponentLatency } from "@vent/shared";
import { BaseAudioChannel } from "./audio-channel.js";
import { SharedSipServer, type SharedSipServerConfig } from "./shared-sip-server.js";

const BLAND_API_BASE = "https://api.bland.ai";

/** Bland call parameters passable from platform config */
export interface BlandCallOptions {
  /** Task prompt — used instead of pathway_id for simple agents */
  task?: string;
  /** Tool definitions (inline objects) or tool IDs (TL-xxx strings) */
  tools?: unknown[];
  /** Voice name ("maya", "josh") or UUID */
  voice?: string;
  /** Model: "base" (full features), "enhanced" (faster), "turbo" (fastest, no tools) */
  model?: string;
  /** Opening sentence — overrides any greeting in the task/pathway */
  first_sentence?: string;
  /** If true, agent waits for callee to speak first (default: false) */
  wait_for_greeting?: boolean;
  /** Max call duration in minutes (default: 30) */
  max_duration?: number;
  /** Temperature 0-1 (default: 0.7) */
  temperature?: number;
  /** Language code e.g. "babel-en", "babel-es" */
  language?: string;
  /** How quickly agent stops speaking when interrupted, in ms (default: 500) */
  interruption_threshold?: number;
}

export interface BlandAudioChannelConfig {
  apiKey: string;
  /** pathway_id (UUID) or empty if using task mode */
  agentId?: string;
  /** Shared SIP server config (Twilio credentials + public host) */
  server: SharedSipServerConfig;
  /** Bland-specific call options */
  callOptions?: BlandCallOptions;
}

interface BlandTranscriptEntry {
  id: string;
  created_at: string;
  text: string;
  user: "user" | "assistant" | "robot" | "agent-action";
}

interface BlandCorrectedTranscriptEntry {
  speaker: number;
  speaker_label: "user" | "assistant";
  text: string;
  start: number;
  end: number;
  confidence: number;
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
  call_length?: number;
  corrected_duration?: string;
  price?: number;
  recording_url?: string;
  summary?: string;
  answered_by?: string;
  call_ended_by?: string;
  error_message?: string;
}

export class BlandAudioChannel extends BaseAudioChannel {
  private config: BlandAudioChannelConfig;
  private sharedServer: SharedSipServer | null = null;
  private channelId: string;
  private toolCallToken: string;
  private ws: WebSocket | null = null;
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private callId: string | null = null;
  private cachedCallResponse: BlandCallResponse | null = null;
  private cachedCorrectedTranscripts: BlandCorrectedTranscriptEntry[] | null = null;
  private componentLatencies: ComponentLatency[] = [];

  constructor(config: BlandAudioChannelConfig) {
    super();
    this.config = config;
    this.channelId = randomBytes(12).toString("hex");
    this.toolCallToken = randomBytes(24).toString("hex");
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();

    // 1. Acquire shared server (starts HTTP + Twilio on first channel)
    this.sharedServer = await SharedSipServer.acquire(this.config.server);

    const webhookUrl = `${this.sharedServer.publicBaseUrl}/bland-webhook/${this.channelId}`;

    // 2. Register for WebSocket dispatch (FIFO queue)
    const connectionPromise = this.sharedServer.registerChannel({
      channelId: this.channelId,
      webhookHandler: (req, res) => this.handleBlandWebhook(req, res),
      toolCallToken: this.toolCallToken,
      toolCallHandler: (req, res) => this.handleToolCallPost(req, res),
    });

    // Prevent unhandled rejection if timeout fires while we're blocked on initiation lock
    let connectionError: Error | null = null;
    connectionPromise.catch((err) => {
      connectionError = err;
    });

    // 3. Acquire initiation lock (serializes Bland API calls, 10s gap)
    const releaseInit = await this.sharedServer.acquireInitiationLock();

    // Check if connection already timed out while waiting for lock
    if (connectionError) {
      releaseInit();
      throw connectionError;
    }

    try {
      // 4. Fire POST /v1/calls → Bland dials our number
      await this.initiateCall(webhookUrl);
    } catch (err) {
      releaseInit();
      throw err;
    }

    // Release lock immediately after POST — don't hold through WebSocket connect.
    // The 10s gap in acquireInitiationLock() handles rate limiting.
    releaseInit();

    // 5. Wait for Bland's call to arrive (WebSocket connects)
    const { ws, streamSid, callSid } = await connectionPromise;
    this.ws = ws;
    this.streamSid = streamSid;
    this.callSid = callSid;

    // Set up audio message handling
    this.setupMediaHandlers();

    this._stats.connectLatencyMs = Date.now() - connectStart;
    console.log(`[bland] Connected: call_id=${this.callId}, callSid=${this.callSid}, took ${this._stats.connectLatencyMs}ms`);
  }

  sendAudio(pcm: Buffer): void {
    if (!this.ws || !this.streamSid) {
      throw new Error("Bland SIP channel not connected");
    }

    this._stats.bytesSent += pcm.length;
    const pcm8k = resample(pcm, 24000, 8000);
    const mulaw = pcmToMulaw(pcm8k);

    const CHUNK_SIZE = 160; // 20ms at 8kHz mulaw
    for (let offset = 0; offset < mulaw.length; offset += CHUNK_SIZE) {
      const chunk = mulaw.subarray(offset, Math.min(offset + CHUNK_SIZE, mulaw.length));
      this.ws.send(
        JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: chunk.toString("base64") },
        }),
      );
    }
  }

  async disconnect(): Promise<void> {
    // Hang up the Twilio call
    if (this.callSid && this.config.server.accountSid) {
      const twilio = (await import("twilio")).default(
        this.config.server.accountSid,
        this.config.server.authToken,
      );
      await twilio
        .calls(this.callSid)
        .update({ status: "completed" })
        .catch(() => {});
      this.callSid = null;
    }

    // Close our WebSocket (doesn't affect the shared server)
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Release our ref on the shared server
    if (this.sharedServer) {
      await this.sharedServer.release(this.channelId);
      this.sharedServer = null;
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

    const durationS =
      data.corrected_duration != null
        ? parseFloat(data.corrected_duration)
        : data.call_length != null
          ? data.call_length * 60
          : undefined;

    let endedReason = data.status;
    if (data.call_ended_by) endedReason = `ended_by_${data.call_ended_by.toLowerCase()}`;
    if (data.error_message) endedReason = `error: ${data.error_message}`;

    return {
      platform: "bland",
      ended_reason: endedReason,
      duration_s: durationS,
      cost_usd: data.price,
      recording_url: data.recording_url ?? undefined,
      summary: data.summary ?? undefined,
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return this.componentLatencies;
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    if (this.cachedCorrectedTranscripts?.length) {
      const transcripts: Array<{ turnIndex: number; text: string }> = [];
      let callerTurnIndex = 0;
      for (const entry of this.cachedCorrectedTranscripts) {
        if (entry.speaker_label === "user") {
          transcripts.push({ turnIndex: callerTurnIndex, text: entry.text });
          callerTurnIndex++;
        } else if (entry.speaker_label === "assistant") {
          callerTurnIndex++;
        }
      }
      return transcripts;
    }

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

  // ── Private helpers ────────────────────────────────────────

  private async initiateCall(webhookUrl: string): Promise<void> {
    const callBody = this.buildCallBody(webhookUrl);
    console.log(
      `[bland] POST /v1/calls → phone_number: ${callBody.phone_number}, pathway_id: ${callBody.pathway_id ?? "none"}`,
    );

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const res = await fetch(`${BLAND_API_BASE}/v1/calls`, {
        method: "POST",
        headers: {
          authorization: this.config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(callBody),
      });

      if (res.status === 429) {
        console.warn(`[bland] Rate limited (429), waiting 10s before retry ${attempt + 1}/${MAX_RETRIES}...`);
        await sleep(10_000);
        continue;
      }

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Bland POST /v1/calls failed (${res.status}): ${errorText}`);
      }

      const callData = (await res.json()) as { call_id?: string; status?: string; message?: string };
      if (!callData.call_id) {
        throw new Error(`Bland POST /v1/calls response missing call_id: ${JSON.stringify(callData)}`);
      }

      this.callId = callData.call_id;
      console.log(`[bland] Call initiated: ${this.callId}, waiting for Bland to dial...`);
      return;
    }

    throw new Error("Bland POST /v1/calls failed: rate limited after 3 retries");
  }

  private buildCallBody(webhookUrl: string): Record<string, unknown> {
    const opts = this.config.callOptions;
    const body: Record<string, unknown> = {
      phone_number: this.config.server.fromNumber,
      record: true,
      wait_for_greeting: opts?.wait_for_greeting ?? false,
      webhook: webhookUrl,
      webhook_events: ["latency", "tool", "call"],
    };

    if (this.config.agentId) body.pathway_id = this.config.agentId;
    if (opts?.task) body.task = opts.task;
    if (opts?.voice) body.voice = opts.voice;
    if (opts?.model) body.model = opts.model;
    if (opts?.first_sentence) body.first_sentence = opts.first_sentence;
    if (opts?.max_duration != null) body.max_duration = opts.max_duration;
    if (opts?.temperature != null) body.temperature = opts.temperature;
    if (opts?.language) body.language = opts.language;
    if (opts?.interruption_threshold != null) body.interruption_threshold = opts.interruption_threshold;
    if (opts?.tools?.length) body.tools = opts.tools;

    return body;
  }

  private setupMediaHandlers(): void {
    if (!this.ws) return;

    this.ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      let raw: string;
      if (Buffer.isBuffer(data)) {
        raw = data.toString();
      } else if (data instanceof ArrayBuffer) {
        raw = Buffer.from(new Uint8Array(data)).toString();
      } else {
        raw = Buffer.concat(data as Buffer[]).toString();
      }

      let msg: { event: string; media?: { payload: string } };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.event === "media" && msg.media?.payload) {
        const mulaw = Buffer.from(msg.media.payload, "base64");
        this._stats.bytesReceived += mulaw.length;
        const pcm8k = mulawToPcm(mulaw);
        const pcm24k = resample(pcm8k, 8000, 24000);
        this.emit("audio", pcm24k);
      }

      if (msg.event === "stop") {
        this.emit("disconnected");
      }
    });

    this.ws.on("close", () => {
      this.emit("disconnected");
    });

    this.ws.on("error", (err) => {
      this._stats.errorEvents.push(err.message);
      this.emit("error", err);
    });
  }

  private handleBlandWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');

      try {
        const event = JSON.parse(body) as Record<string, unknown>;
        const eventType = (event.event ?? event.type ?? event.category ?? "") as string;

        console.log(`[bland] Webhook (${this.channelId}): type=${eventType} ${JSON.stringify(event)}`);

        if (eventType === "latency" || event.stt_latency != null || event.llm_latency != null || event.tts_latency != null) {
          // Check top-level fields first, then nested under event.data
          const source = (typeof event.data === "object" && event.data !== null ? event.data : event) as Record<string, unknown>;
          const stt = typeof source.stt_latency === "number" ? source.stt_latency : (typeof event.stt_latency === "number" ? event.stt_latency : undefined);
          const llm = typeof source.llm_latency === "number" ? source.llm_latency : (typeof event.llm_latency === "number" ? event.llm_latency : undefined);
          const tts = typeof source.tts_latency === "number" ? source.tts_latency : (typeof event.tts_latency === "number" ? event.tts_latency : undefined);

          if (stt != null || llm != null || tts != null) {
            const timing: ComponentLatency = {};
            if (stt != null) timing.stt_ms = stt;
            if (llm != null) timing.llm_ms = llm;
            if (tts != null) timing.tts_ms = tts;
            this.componentLatencies.push(timing);
          }
        }
      } catch {
        // Ignore malformed webhook payloads
      }
    });
  }

  private handleToolCallPost(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');
      // Tool call tracking could be added here if needed
    });
  }

  // ── Post-call data ────────────────────────────────────────

  private async fetchCallResponse(): Promise<BlandCallResponse | null> {
    if (this.cachedCallResponse) return this.cachedCallResponse;
    if (!this.callId) return null;

    const delays = [200, 400, 800, 1500, 3000, 5000];
    for (const delay of delays) {
      await sleep(delay);
      const res = await fetch(`${BLAND_API_BASE}/v1/calls/${this.callId}`, {
        headers: { authorization: this.config.apiKey },
      });
      if (!res.ok) continue;

      const data = (await res.json()) as BlandCallResponse;
      if (data.completed || data.status === "completed" || data.status === "failed") {
        this.cachedCallResponse = data;
        await this.fetchCorrectedTranscripts();
        if (this.componentLatencies.length === 0) {
          await this.fetchEventStream();
        }
        return data;
      }
    }

    return null;
  }

  private async fetchCorrectedTranscripts(): Promise<void> {
    if (!this.callId) return;
    try {
      const res = await fetch(`${BLAND_API_BASE}/v1/calls/${this.callId}/correct`, {
        headers: { authorization: this.config.apiKey },
      });
      if (res.ok) {
        const data = (await res.json()) as BlandCorrectedTranscriptEntry[] | { aligned?: BlandCorrectedTranscriptEntry[] };
        if (Array.isArray(data) && data.length > 0) {
          this.cachedCorrectedTranscripts = data;
        } else if (!Array.isArray(data) && data.aligned?.length) {
          this.cachedCorrectedTranscripts = data.aligned;
        }
      }
    } catch {
      // Non-critical — fall back to raw transcripts
    }
  }

  private async fetchEventStream(): Promise<void> {
    if (!this.callId) return;
    try {
      const res = await fetch(`${BLAND_API_BASE}/v1/event_stream/${this.callId}`, {
        headers: { authorization: this.config.apiKey },
      });
      if (!res.ok) return;

      const events = (await res.json()) as Array<{
        level?: string;
        message?: string;
        category?: string;
        call_id?: string;
        timestamp?: string;
      }>;

      console.log(`[bland] Event stream: ${events.length} events for ${this.callId}`);

      for (const evt of events) {
        if (evt.category === "performance" && evt.message) {
          console.log(`[bland] Performance event: ${evt.message}`);
          const timing: ComponentLatency = {};
          const sttMatch = evt.message.match(/stt[:\s]+(\d+)/i);
          const llmMatch = evt.message.match(/llm[:\s]+(\d+)/i);
          const ttsMatch = evt.message.match(/tts[:\s]+(\d+)/i);
          if (sttMatch) timing.stt_ms = parseInt(sttMatch[1]!, 10);
          if (llmMatch) timing.llm_ms = parseInt(llmMatch[1]!, 10);
          if (ttsMatch) timing.tts_ms = parseInt(ttsMatch[1]!, 10);
          if (timing.stt_ms != null || timing.llm_ms != null || timing.tts_ms != null) {
            this.componentLatencies.push(timing);
          }
        }
      }
    } catch {
      // Non-critical — webhooks are primary source
    }
  }

  private parseToolCalls(data: BlandCallResponse): ObservedToolCall[] {
    const toolCalls: ObservedToolCall[] = [];

    const transcripts = data.transcripts ?? [];
    for (const entry of transcripts) {
      if (entry.user === "agent-action") {
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
