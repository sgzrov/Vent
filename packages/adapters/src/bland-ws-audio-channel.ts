/**
 * Bland AI Audio Channel (WebSocket transport)
 *
 * Direct WebSocket connection to Bland's Web Agent API.
 * Binary PCM16 audio at 44.1kHz wire rate, resampled to 24kHz internally.
 *
 * Flow:
 * 1. POST /v1/agents — create ephemeral web agent with pathway/task + webhook
 * 2. POST /v1/agents/{id}/authorize — get single-use token
 * 3. Connect wss://stream-v2.aws.dc8.bland.ai/ws/connect/blandshared?agent={id}&token={token}&sampleRate=24000
 * 4. Binary frames = PCM16 bidirectional. Text frames = JSON events.
 * 5. On session end, Bland POSTs call_id to our webhook URL.
 * 6. Post-call: GET /v1/calls/{call_id} for full data.
 * 7. Cleanup: DELETE /v1/agents/{id}.
 */

import http from "node:http";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { resample } from "@vent/voice";
import type { ObservedToolCall, CallMetadata, ComponentLatency } from "@vent/shared";
import { BaseAudioChannel, type SendAudioOptions } from "./audio-channel.js";
import { WebhookServer } from "./webhook-server.js";
import {
  BLAND_API_BASE,
  type BlandCallOptions,
  type BlandCallResponse,
  type BlandCorrectedTranscriptEntry,
  parseBlandToolCalls,
  extractBlandTransfers,
  fetchBlandCallResponse,
  fetchBlandCorrectedTranscripts,
  fetchBlandEventStream,
  buildBlandCallMetadata,
  buildBlandTranscripts,
  getFullCallerTranscriptFromData,
  getAgentTextFromData,
  parseLatencyMessage,
  compactUnknownRecord,
  sleep,
} from "./bland-shared.js";

export interface BlandWsAudioChannelConfig {
  apiKey: string;
  /** pathway_id (UUID) or empty if using task mode */
  agentId?: string;
  /** Public base URL for webhook callbacks (e.g. https://host.fly.dev) */
  publicBaseUrl: string;
  /** Bland-specific call options */
  callOptions?: BlandCallOptions;
}

/** Audio energy threshold for detecting agent speech start. Below this
 *  amplitude a frame is considered silent. Used only to fire
 *  `platformSpeechStart` so the collector can extend a turn through
 *  inter-sentence pauses — never to fire `platformEndOfTurn`. */
const SILENCE_MAX_AMPLITUDE = 200;

/** Comfort noise: 20ms frame at 44100Hz = 882 samples = 1764 bytes */
const COMFORT_NOISE_FRAME_SAMPLES = 882;
const COMFORT_NOISE_INTERVAL_MS = 20;
const COMFORT_NOISE_AMPLITUDE = 400;

const WS_CONNECT_TIMEOUT_MS = 30_000;
const CALL_ID_TIMEOUT_MS = 10_000;

const BLAND_WS_BASE = "wss://stream-v2.aws.dc8.bland.ai";

export class BlandWsAudioChannel extends BaseAudioChannel {
  protected override outputSampleRate = 44100;
  protected override pacingIntervalMs = 10; // 2x real-time

  // Bland's WS does not emit reliable agent speech-state events (its client SDK
  // just generic-forwards JSON, no transcript/speech_start/speech_stop event
  // types exist on the wire). An audio-silence heuristic on the receive PCM
  // is too aggressive for inter-sentence TTS pauses and was truncating
  // greetings mid-utterance. Match Vapi's strategy: drive end-of-turn from
  // the collector's VAD with a continuation grace, and only emit
  // `platformSpeechStart` from local energy detection so the collector can
  // extend a turn when the agent resumes after a pause.
  hasPlatformEndOfTurn = false;
  preferredSilenceThresholdMs = 1200;
  postVadContinuationMs = 1000;
  postToolCallContinuationMs = 2000;

  private config: BlandWsAudioChannelConfig;
  private ws: WebSocket | null = null;
  private webAgentId: string | null = null;
  private channelId: string;
  private callId: string | null = null;
  private callIdResolve: (() => void) | null = null;

  private cachedCallResponse: BlandCallResponse | null = null;
  private cachedCorrectedTranscripts: BlandCorrectedTranscriptEntry[] | null = null;
  private componentLatencies: ComponentLatency[] = [];
  private realtimeToolCalls: ObservedToolCall[] = [];
  private realtimeCitations: unknown[] = [];

  // Tracks transitions silent → speaking on the receive audio so we can fire
  // `platformSpeechStart` once per resumption (used by the collector to
  // cancel the post-VAD continuation grace when the agent picks back up).
  private _agentSpeaking = false;

  // Comfort noise
  private comfortNoiseTimer: ReturnType<typeof setInterval> | null = null;

  // Playback sample rate (may be updated by server JSON message)
  private playbackSampleRate = 44100;

  // WebhookServer ref (for webhook routing)
  private webhookServer: WebhookServer | null = null;

  // EOT analysis logging
  private callStartedAt: number | null = null;
  private webhookLog: Array<{ type: string; relativeMs: number; detail: string }> = [];

  constructor(config: BlandWsAudioChannelConfig) {
    super();
    this.config = config;
    this.channelId = randomBytes(12).toString("hex");
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    this.enableRecordingCapture();
    this.realtimeCitations = [];

    // 1. Get WebhookServer instance for receiving Bland callbacks
    this.webhookServer = await WebhookServer.acquire({
      publicHost: new URL(this.config.publicBaseUrl).hostname,
      port: parseInt(process.env["RUNNER_LISTEN_PORT"] ?? "0", 10) || undefined,
      publicPort: process.env["RUNNER_LISTEN_PORT"] ? null : undefined,
    });

    const machineId = process.env["FLY_MACHINE_ID"];
    const webhookPath = machineId
      ? `/bland-ws-webhook/${machineId}/${this.channelId}`
      : `/bland-ws-webhook/${this.channelId}`;
    const webhookUrl = `${this.config.publicBaseUrl}${webhookPath}`;

    // Register webhook handler for this channel
    this.webhookServer.registerHandler(this.channelId, (req, res) => this.handleWebhook(req, res));

    // 2. Create ephemeral web agent
    const agentBody = this.buildAgentBody(webhookUrl);
    console.log(`[bland-ws] POST /v1/agents → pathway_id: ${agentBody.pathway_id ?? "none"}`);

    const agentRes = await fetch(`${BLAND_API_BASE}/v1/agents`, {
      method: "POST",
      headers: {
        authorization: this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(agentBody),
    });

    if (!agentRes.ok) {
      const errorText = await agentRes.text();
      throw new Error(`Bland POST /v1/agents failed (${agentRes.status}): ${errorText}`);
    }

    const agentData = (await agentRes.json()) as { agent?: { agent_id?: string }; agent_id?: string };
    this.webAgentId = agentData.agent?.agent_id ?? agentData.agent_id ?? null;
    if (!this.webAgentId) {
      throw new Error(`Bland POST /v1/agents response missing agent_id: ${JSON.stringify(agentData)}`);
    }
    console.log(`[bland-ws] Created web agent: ${this.webAgentId}`);

    // 3. Authorize session
    const authRes = await fetch(`${BLAND_API_BASE}/v1/agents/${this.webAgentId}/authorize`, {
      method: "POST",
      headers: {
        authorization: this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (!authRes.ok) {
      const errorText = await authRes.text();
      await this.deleteWebAgent();
      throw new Error(`Bland POST /v1/agents/${this.webAgentId}/authorize failed (${authRes.status}): ${errorText}`);
    }

    const authData = (await authRes.json()) as { token?: string };
    const token = authData.token;
    if (!token) {
      await this.deleteWebAgent();
      throw new Error(`Bland authorize response missing token: ${JSON.stringify(authData)}`);
    }

    // 4. Connect WebSocket
    const wsUrl = `${BLAND_WS_BASE}/ws/connect/blandshared?agent=${this.webAgentId}&token=${token}&sampleRate=${this.playbackSampleRate}`;
    console.log(`[bland-ws] Connecting WebSocket...`);

    await this.connectWebSocket(wsUrl);
    this._stats.connectLatencyMs = Date.now() - connectStart;
    console.log(`[bland-ws] Connected, took ${this._stats.connectLatencyMs}ms`);

    // Start comfort noise
    this.startComfortNoise();
  }

  protected async writeAudioFrame(samples: Int16Array, _sampleRate: number): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  override sendAudio(pcm: Buffer, opts?: SendAudioOptions): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Bland WebSocket channel not connected");
    }
    this.stopComfortNoise();
    super.sendAudio(pcm, opts);
  }

  startComfortNoise(): void {
    if (this.comfortNoiseTimer) return;
    // Send zero-filled silence frames instead of random noise.
    // Bland's server-side VAD detects non-zero audio as speech and triggers
    // barge-in, cutting the agent mid-sentence. Their browser SDK relies on
    // noise suppression to send near-zero audio when the user is silent.
    const silenceFrame = Buffer.alloc(COMFORT_NOISE_FRAME_SAMPLES * 2); // zeros
    this.comfortNoiseTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopComfortNoise();
        return;
      }
      this.ws.send(silenceFrame);
    }, COMFORT_NOISE_INTERVAL_MS);
  }

  stopComfortNoise(): void {
    if (this.comfortNoiseTimer) {
      clearInterval(this.comfortNoiseTimer);
      this.comfortNoiseTimer = null;
    }
  }

  async disconnect(): Promise<void> {
    this.stopComfortNoise();
    this._agentSpeaking = false;

    // Close WebSocket
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    // Cleanup: delete ephemeral web agent
    await this.deleteWebAgent();

    // Unregister webhook handler
    if (this.webhookServer) {
      this.webhookServer.unregisterHandler(this.channelId);
      await this.webhookServer.release();
      this.webhookServer = null;
    }
  }

  // ── Post-call data ────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    await this.waitForCallId();
    const data = await this.fetchCallResponseCached();
    if (!data) return [...this.realtimeToolCalls];
    const parsed = parseBlandToolCalls(data);
    return parsed.length > 0 ? parsed : [...this.realtimeToolCalls];
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    await this.waitForCallId();
    const data = await this.fetchCallResponseCached();
    if (!data) {
      const providerMetadata = compactUnknownRecord({
        citations: this.realtimeCitations.length > 0 ? this.realtimeCitations : undefined,
      });
      if (!this.callId && !providerMetadata) return null;
      return {
        platform: "bland",
        provider_call_id: this.callId ?? undefined,
        provider_metadata: providerMetadata,
      };
    }

    return buildBlandCallMetadata(data, this.callId, this.realtimeCitations, this.componentLatencies);
  }

  getComponentTimings(): ComponentLatency[] {
    return this.componentLatencies;
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    return buildBlandTranscripts(this.cachedCallResponse, this.cachedCorrectedTranscripts);
  }

  consumeAgentText(): string {
    return getAgentTextFromData(this.cachedCallResponse);
  }

  getFullCallerTranscript(): string {
    return getFullCallerTranscriptFromData(this.cachedCallResponse, this.cachedCorrectedTranscripts);
  }

  // ── Private: WebSocket connection ─────────────────────────

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          reject(new Error(`Bland WebSocket connect timeout (${WS_CONNECT_TIMEOUT_MS}ms)`));
        }
      }, WS_CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        this.ws = ws;
        this.callStartedAt = Date.now();
        this._connectTimestampMs = this.callStartedAt;
        this._connectMonotonicMs = performance.now();
        this.setupHandlers(ws);
        resolve();
      });

      ws.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        } else {
          this._stats.errorEvents.push(err.message);
          this.emit("error", err);
        }
      });

      ws.on("close", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error("Bland WebSocket closed before open"));
        }
      });
    });
  }

  private setupHandlers(ws: WebSocket): void {
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        this.handleBinaryFrame(data);
      } else {
        this.handleTextFrame(data);
      }
    });

    ws.on("close", () => {
      this.stopComfortNoise();
      this.ws = null;
      this.emit("disconnected");
    });

    ws.on("error", (err) => {
      this._stats.errorEvents.push(err.message);
      this.emit("error", err);
    });
  }

  private handleBinaryFrame(data: Buffer | ArrayBuffer | Buffer[]): void {
    let raw: Buffer;
    if (Buffer.isBuffer(data)) {
      raw = data;
    } else if (data instanceof ArrayBuffer) {
      raw = Buffer.from(new Uint8Array(data));
    } else {
      raw = Buffer.concat(data as Buffer[]);
    }

    this._stats.bytesReceived += raw.length;

    // Resample if server negotiated a different playback rate
    let pcm24k: Buffer;
    if (this.playbackSampleRate !== 24000) {
      pcm24k = resample(raw, this.playbackSampleRate, 24000);
    } else {
      pcm24k = raw;
    }

    this.captureAgentAudio(pcm24k, performance.now() - this._connectMonotonicMs);
    this.processAgentAudioSilence(pcm24k);
    this.emit("audio", pcm24k);
  }

  private handleTextFrame(data: Buffer | ArrayBuffer | Buffer[]): void {
    let raw: string;
    if (Buffer.isBuffer(data)) {
      raw = data.toString();
    } else if (data instanceof ArrayBuffer) {
      raw = Buffer.from(new Uint8Array(data)).toString();
    } else {
      raw = Buffer.concat(data as Buffer[]).toString();
    }

    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;

      // Check for playback sample rate negotiation (Bland uses multiple field names)
      const negotiatedRate = (msg.playbackSampleRate ?? msg.sample_rate ?? msg.sampleRate ?? msg.pcm_sample_rate) as number | undefined;
      if (typeof negotiatedRate === "number" && negotiatedRate > 0 && negotiatedRate !== this.playbackSampleRate) {
        console.log(`[bland-ws] Server negotiated sampleRate: ${this.playbackSampleRate} → ${negotiatedRate}`);
        this.playbackSampleRate = negotiatedRate;
      }

      // Extract call_id from WebSocket (sent as callID event)
      const type = (msg.type ?? msg.event ?? "") as string;
      if (type === "callID" && typeof msg.payload === "string" && !this.callId) {
        this.callId = msg.payload;
        console.log(`[bland-ws] Got call_id from WebSocket: ${this.callId}`);
        if (this.callIdResolve) {
          this.callIdResolve();
          this.callIdResolve = null;
        }
      }

      // Log all JSON messages for debugging
      console.log(`[bland-ws] Text event: ${type || "unknown"} ${JSON.stringify(msg).slice(0, 250)}`);
    } catch {
      // Not JSON — ignore
    }
  }

  // ── Speech-start detection on receive audio ───────────────

  private static isSilentFrame(pcm: Buffer): boolean {
    const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    let maxAmp = 0;
    for (let i = 0; i < int16.length; i++) {
      const abs = int16[i]! < 0 ? -int16[i]! : int16[i]!;
      if (abs > maxAmp) maxAmp = abs;
    }
    return maxAmp < SILENCE_MAX_AMPLITUDE;
  }

  private processAgentAudioSilence(pcm24k: Buffer): void {
    const silent = BlandWsAudioChannel.isSilentFrame(pcm24k);
    if (silent) {
      if (this._agentSpeaking) this._agentSpeaking = false;
      return;
    }
    if (!this._agentSpeaking) {
      this._agentSpeaking = true;
      this.emit("platformSpeechStart");
    }
  }

  // ── Webhook handler ───────────────────────────────────────

  private handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
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

        console.log(`[bland-ws] Webhook (${this.channelId}): type=${eventType} ${JSON.stringify(event).slice(0, 500)}`);

        const relMs = this.eotRelMs();
        this.webhookLog.push({ type: eventType, relativeMs: relMs, detail: (event.message ?? "") as string });

        // Extract call_id from webhook — this is our main way to get it
        const webhookCallId = (event.call_id ?? event.callId) as string | undefined;
        if (webhookCallId && !this.callId) {
          this.callId = webhookCallId;
          console.log(`[bland-ws] Got call_id from webhook: ${this.callId}`);
          if (this.callIdResolve) {
            this.callIdResolve();
            this.callIdResolve = null;
          }
        }

        // Parse latency events
        if (eventType === "latency" || event.category === "latency") {
          const msg = (event.message ?? "") as string;
          const timing = parseLatencyMessage(msg);
          if (timing) {
            this.componentLatencies.push(timing);
            console.log(`[bland-ws] latency: STT=${timing.stt_ms ?? "?"}ms LLM=${timing.llm_ms ?? "?"}ms TTS=${timing.tts_ms ?? "?"}ms`);
          }
        }

        // Bland webhooks fire only after tool completion — no real-time tool-call-start
        // signal, so toolCallActive gating is not available on this adapter.

        // Capture dynamic_data events
        if (eventType === "dynamic_data") {
          const data = (typeof event.data === "object" && event.data !== null ? event.data : event) as Record<string, unknown>;
          const name = (data.url ?? data.name ?? data.tool_name ?? "dynamic_data") as string;
          this.realtimeToolCalls.push({
            name,
            arguments: (data.request_data ?? data.params ?? {}) as Record<string, unknown>,
            result: data.response ?? data.result ?? data.response_data,
            successful: data.status === "success" || data.status_code === 200 || data.response != null,
            timestamp_ms: relMs,
          });
        }

        // Capture webhook events
        if (eventType === "webhook") {
          const data = (typeof event.data === "object" && event.data !== null ? event.data : event) as Record<string, unknown>;
          const name = (data.url ?? data.name ?? data.tool_name ?? "webhook") as string;
          this.realtimeToolCalls.push({
            name,
            arguments: (data.request_data ?? data.params ?? {}) as Record<string, unknown>,
            result: data.response ?? data.result ?? data.response_data,
            successful: data.status === "success" || data.status_code === 200 || data.response != null,
            timestamp_ms: relMs,
          });
        }

        if (eventType === "citations") {
          const citationPayload = event.data ?? event.citations ?? event.result ?? event;
          this.realtimeCitations.push(citationPayload);
        }

        // Capture "Storing dynamic data" from call events
        if (eventType === "call") {
          const msg = (event.message ?? "") as string;
          const storeMatch = msg.match(/^Storing dynamic data:\s*\n\n\s*(\S+)\s*:\s*([\s\S]+)$/);
          if (storeMatch) {
            const varName = storeMatch[1]!;
            let varValue: unknown = storeMatch[2]!.trim();
            try { varValue = JSON.parse(varValue as string); } catch { /* keep as string */ }
            this.realtimeToolCalls.push({
              name: `store_${varName}`,
              arguments: {},
              result: varValue,
              successful: true,
              timestamp_ms: relMs,
            });
          }
        }
      } catch {
        // Ignore malformed webhook payloads
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────

  private eotRelMs(): number {
    return Date.now() - (this.callStartedAt ?? Date.now());
  }

  private buildAgentBody(webhookUrl: string): Record<string, unknown> {
    const opts = this.config.callOptions;
    const body: Record<string, unknown> = {
      record: true,
      wait_for_greeting: opts?.wait_for_greeting ?? false,
      webhook: webhookUrl,
      webhook_events: ["latency", "tool", "call", "dynamic_data", "webhook", "citations"],
    };

    if (this.config.agentId) body.pathway_id = this.config.agentId;
    if (opts?.task) body.task = opts.task;
    if (opts?.persona_id) body.persona_id = opts.persona_id;
    if (opts?.voice) body.voice = opts.voice;
    if (opts?.model) body.model = opts.model;
    if (opts?.first_sentence) body.first_sentence = opts.first_sentence;
    if (opts?.max_duration != null) body.max_duration = opts.max_duration;
    if (opts?.temperature != null) body.temperature = opts.temperature;
    if (opts?.language) body.language = opts.language;
    if (opts?.interruption_threshold != null) body.interruption_threshold = opts.interruption_threshold;
    if (opts?.block_interruptions != null) body.block_interruptions = opts.block_interruptions;
    if (opts?.noise_cancellation != null) body.noise_cancellation = opts.noise_cancellation;
    if (opts?.tools?.length) body.tools = opts.tools;
    if (opts?.background_track !== undefined) body.background_track = opts.background_track;
    if (opts?.keywords?.length) body.keywords = opts.keywords;
    if (opts?.request_data) body.request_data = opts.request_data;
    if (opts?.pronunciation_guide?.length) body.pronunciation_guide = opts.pronunciation_guide;
    if (opts?.start_node_id) body.start_node_id = opts.start_node_id;
    if (opts?.pathway_version != null) body.pathway_version = opts.pathway_version;

    body.metadata = { vent_channel_id: this.channelId };

    return body;
  }

  /** Wait for call_id to arrive from webhook, with timeout. */
  private async waitForCallId(): Promise<void> {
    if (this.callId) return;
    await new Promise<void>((resolve) => {
      this.callIdResolve = resolve;
      setTimeout(() => {
        if (!this.callId) {
          console.warn(`[bland-ws] call_id not received within ${CALL_ID_TIMEOUT_MS}ms`);
        }
        resolve();
        this.callIdResolve = null;
      }, CALL_ID_TIMEOUT_MS);
    });
  }

  private async fetchCallResponseCached(): Promise<BlandCallResponse | null> {
    if (this.cachedCallResponse) return this.cachedCallResponse;
    if (!this.callId) return null;

    const data = await fetchBlandCallResponse(this.config.apiKey, this.callId);
    if (!data) return null;

    this.cachedCallResponse = data;
    this.cachedCorrectedTranscripts = await fetchBlandCorrectedTranscripts(this.config.apiKey, this.callId);
    if (this.componentLatencies.length === 0) {
      const eventLatencies = await fetchBlandEventStream(this.config.apiKey, this.callId);
      this.componentLatencies.push(...eventLatencies);
    }
    return data;
  }

  /** Delete the ephemeral web agent (cleanup, errors ignored). */
  private async deleteWebAgent(): Promise<void> {
    if (!this.webAgentId) return;
    const agentId = this.webAgentId;
    this.webAgentId = null;
    try {
      await fetch(`${BLAND_API_BASE}/v1/agents/${agentId}`, {
        method: "DELETE",
        headers: { authorization: this.config.apiKey },
      });
      console.log(`[bland-ws] Deleted web agent: ${agentId}`);
    } catch {
      // Cleanup error — ignore
    }
  }
}
