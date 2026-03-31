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
import { BaseAudioChannel, type SendAudioOptions } from "./audio-channel.js";
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
  /** When true, agent will not respond to or process interruptions from the user */
  block_interruptions?: boolean;
  /** When true, enable Bland's noise filtering on caller audio */
  noise_cancellation?: boolean;
  /** Background audio: "office", "cafe", "restaurant", "none", or null (default phone static) */
  background_track?: string | null;
  /** Boost transcription accuracy for specific words. Supports "word:boost_factor" format. */
  keywords?: string[];
  /** Key-value pairs accessible as {{variable}} in agent prompts/pathways */
  request_data?: Record<string, unknown>;
  /** Pronunciation overrides: [{ word, pronunciation, case_sensitive?, spaced? }] */
  pronunciation_guide?: Array<{ word: string; pronunciation: string; case_sensitive?: boolean; spaced?: boolean }>;
  /** Start pathway from a specific node instead of the default */
  start_node_id?: string;
  /** Specific pathway version to test (default: production) */
  pathway_version?: number;
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

interface BlandPathwayLogEntry {
  tag?: { name?: string; color?: string };
  role?: string;
  text?: string;
  decision?: string; // JSON string with prompt/node selection details
  created_at?: string;
  pathway_info?: string; // JSON string with request data
  chosen_node_id?: string;
}

interface BlandCallResponse {
  call_id: string;
  status: string;
  completed?: boolean;
  transcripts?: BlandTranscriptEntry[];
  concatenated_transcript?: string;
  variables?: Record<string, unknown>;
  pathway_logs?: BlandPathwayLogEntry[];
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
  private realtimeToolCalls: ObservedToolCall[] = [];
  private firstAudioReceivedAt: number | null = null;
  private firstNonSilentAudioAt: number | null = null;

  // Mark event tracking — resolves when Twilio confirms audio playback is complete
  private pendingMarks = new Map<string, () => void>();
  private markCounter = 0;

  // Comfort noise — keeps SIP line active while pipeline processes
  private comfortNoiseInterval: ReturnType<typeof setInterval> | null = null;

  // EOT analysis logging
  private callStartedAt: number | null = null;
  private webhookLog: Array<{ type: string; relativeMs: number; detail: string }> = [];
  private audioTransitions: Array<{ transition: "speech" | "silence"; relativeMs: number }> = [];
  private lastAudioState: "speech" | "silence" = "silence";

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

  /**
   * Send caller audio to Bland via Twilio media stream.
   *
   * A "clear" event flushes stale buffered audio from a previous turn.
   * After sending, a Twilio "mark" event confirms playback is complete,
   * preventing us from collecting the agent response while our audio is
   * still playing on the SIP line.
   */
  async sendAudio(pcm: Buffer, opts?: SendAudioOptions): Promise<void> {
    if (!this.ws || !this.streamSid) {
      throw new Error("Bland SIP channel not connected");
    }

    const raw = opts?.raw ?? false;

    // Clear any stale audio still buffered from a previous turn
    // (skip for raw sends like interrupts — we want audio to arrive immediately)
    if (!raw) {
      this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
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

    // Mark await: wait for Twilio to confirm our audio finished playing.
    // Skip for raw sends (interrupts, noise injection) where timing is critical.
    if (!raw) {
      const markName = `vent-eot-${++this.markCounter}`;
      const playbackDone = new Promise<void>((resolve) => {
        this.pendingMarks.set(markName, resolve);
        setTimeout(() => {
          if (this.pendingMarks.delete(markName)) {
            console.warn(`[bland] Mark timeout: ${markName} not confirmed after 5s`);
            resolve();
          }
        }, 5_000);
      });

      this.ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: this.streamSid,
          mark: { name: markName },
        }),
      );

      await playbackDone;
    }
  }

  /**
   * Send low-amplitude noise to keep Bland's silence detector from triggering
   * while our pipeline processes (LLM + TTS). Called after agent end-of-turn.
   */
  startComfortNoise(): void {
    if (this.comfortNoiseInterval || !this.ws || !this.streamSid) return;

    const AMPLITUDE = 80; // low but above silence threshold
    const SAMPLES = 160;  // 20ms at 8kHz
    const ws = this.ws;
    const streamSid = this.streamSid;

    this.comfortNoiseInterval = setInterval(() => {
      const pcm8k = Buffer.alloc(SAMPLES * 2);
      for (let i = 0; i < SAMPLES; i++) {
        pcm8k.writeInt16LE(Math.floor((Math.random() * 2 - 1) * AMPLITUDE), i * 2);
      }
      const mulaw = pcmToMulaw(pcm8k);
      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: mulaw.toString("base64") },
      }));
    }, 20);
  }

  stopComfortNoise(): void {
    if (this.comfortNoiseInterval) {
      clearInterval(this.comfortNoiseInterval);
      this.comfortNoiseInterval = null;
    }
  }

  async disconnect(): Promise<void> {
    this.stopComfortNoise();
    // Resolve any pending mark promises so sendAudio doesn't hang
    for (const resolve of this.pendingMarks.values()) resolve();
    this.pendingMarks.clear();

    // EOT analysis: dump interleaved timeline of audio transitions + webhooks
    if (this.audioTransitions.length > 0 || this.webhookLog.length > 0) {
      console.log(`[bland-eot] === Call Timeline (call_id=${this.callId}) ===`);
      const allEvents = [
        ...this.audioTransitions.map((t) => ({
          relativeMs: t.relativeMs,
          label: `audio: → ${t.transition}`,
        })),
        ...this.webhookLog.map((w) => ({
          relativeMs: w.relativeMs,
          label: `webhook: ${w.type} ${w.detail.slice(0, 80)}`,
        })),
      ].sort((a, b) => a.relativeMs - b.relativeMs);
      for (const e of allEvents) {
        console.log(`[bland-eot]   +${e.relativeMs}ms  ${e.label}`);
      }
      console.log(`[bland-eot] === End Timeline ===`);
    }

    await this.endTwilioCall();

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

  /** Hang up the Twilio call leg (idempotent — safe to call multiple times) */
  private async endTwilioCall(): Promise<void> {
    if (!this.callSid || !this.config.server.accountSid) return;
    const sid = this.callSid;
    this.callSid = null; // Prevent double-hangup
    try {
      const twilio = (await import("twilio")).default(
        this.config.server.accountSid,
        this.config.server.authToken,
      );
      await twilio.calls(sid).update({ status: "completed" });
    } catch {
      // Already ended or invalid — ignore
    }
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    // Hang up the Twilio leg first so Bland marks the call as completed
    // before we poll GET /v1/calls/{call_id}
    await this.endTwilioCall();
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
      variables: data.variables,
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
          transcripts.push({ turnIndex: callerTurnIndex, text: stripBlandAnnotations(entry.text) });
          callerTurnIndex++;
        }
        // Skip assistant entries — callerTurnIndex only tracks caller turns
      }
      console.log(`[bland] Corrected transcripts: ${this.cachedCorrectedTranscripts.length} entries → ${transcripts.length} caller turns`);
      return transcripts;
    }

    const data = this.cachedCallResponse;
    if (!data?.transcripts) return [];

    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const entry of data.transcripts) {
      if (entry.user === "user") {
        transcripts.push({ turnIndex: callerTurnIndex, text: stripBlandAnnotations(entry.text) });
        callerTurnIndex++;
      }
      // Skip assistant/robot entries — callerTurnIndex only tracks caller turns
    }
    console.log(`[bland] Raw transcripts: ${data.transcripts.length} entries → ${transcripts.length} caller turns`);
    return transcripts;
  }

  /** Consume accumulated agent transcript text. For Bland, this returns all agent text from post-call data. */
  consumeAgentText(): string {
    const data = this.cachedCallResponse;
    if (!data?.transcripts) return "";
    const text = data.transcripts
      .filter((e) => e.user === "assistant" || e.user === "robot")
      .map((e) => stripBlandAnnotations(e.text))
      .join(" ");
    return text;
  }

  getFullCallerTranscript(): string {
    if (this.cachedCorrectedTranscripts?.length) {
      return this.cachedCorrectedTranscripts
        .filter((e) => e.speaker_label === "user")
        .map((e) => stripBlandAnnotations(e.text))
        .join(" ");
    }
    const data = this.cachedCallResponse;
    if (!data?.transcripts) return "";
    return data.transcripts
      .filter((e) => e.user === "user")
      .map((e) => stripBlandAnnotations(e.text))
      .join(" ");
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
      webhook_events: ["latency", "tool", "call", "dynamic_data", "webhook"],
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

  private eotRelMs(): number {
    return Date.now() - (this.callStartedAt ?? Date.now());
  }

  private setupMediaHandlers(): void {
    if (!this.ws) return;
    this.callStartedAt = Date.now();

    this.ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      let raw: string;
      if (Buffer.isBuffer(data)) {
        raw = data.toString();
      } else if (data instanceof ArrayBuffer) {
        raw = Buffer.from(new Uint8Array(data)).toString();
      } else {
        raw = Buffer.concat(data as Buffer[]).toString();
      }

      let msg: { event: string; media?: { payload: string }; mark?: { name: string } };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // Handle mark confirmations — Twilio sends these when buffered audio
      // playback reaches the mark we placed after our caller audio.
      if (msg.event === "mark" && msg.mark?.name) {
        console.log(`[bland] Mark received: ${msg.mark.name} (pending: ${[...this.pendingMarks.keys()].join(", ")})`);
        const resolve = this.pendingMarks.get(msg.mark.name);
        if (resolve) {
          this.pendingMarks.delete(msg.mark.name);
          resolve();
        }
      }

      if (msg.event === "media" && msg.media?.payload) {
        const mulaw = Buffer.from(msg.media.payload, "base64");
        this._stats.bytesReceived += mulaw.length;
        const pcm8k = mulawToPcm(mulaw);
        const pcm24k = resample(pcm8k, 8000, 24000);

        if (!this.firstAudioReceivedAt) {
          this.firstAudioReceivedAt = Date.now();
        }
        if (!this.firstNonSilentAudioAt) {
          const samples = new Int16Array(pcm24k.buffer, pcm24k.byteOffset, pcm24k.length / 2);
          let hasAudio = false;
          for (let i = 0; i < samples.length; i++) {
            if (Math.abs(samples[i]!) > 200) { hasAudio = true; break; }
          }
          if (hasAudio) {
            this.firstNonSilentAudioAt = Date.now();
            const silencePadMs = this.firstNonSilentAudioAt - this.firstAudioReceivedAt;
            if (silencePadMs > 500) {
              console.warn(`[bland] Silence pad: ${silencePadMs}ms of silence before first word (call_id=${this.callId})`);
            }
          }
        }

        this.emit("audio", pcm24k);

        // EOT logging: track speech ↔ silence transitions
        const samples24k = new Int16Array(pcm24k.buffer, pcm24k.byteOffset, pcm24k.length / 2);
        let chunkHasSpeech = false;
        for (let j = 0; j < samples24k.length; j++) {
          if (Math.abs(samples24k[j]!) > 200) { chunkHasSpeech = true; break; }
        }
        const currentAudioState = chunkHasSpeech ? "speech" as const : "silence" as const;
        if (currentAudioState !== this.lastAudioState) {
          const relMs = this.eotRelMs();
          this.audioTransitions.push({ transition: currentAudioState, relativeMs: relMs });
          console.log(`[bland-eot] audio: ${this.lastAudioState} → ${currentAudioState} at +${relMs}ms`);
          this.lastAudioState = currentAudioState;
        }
      }

      if (msg.event === "stop") {
        this.emit("disconnected");
      }
    });

    this.ws.on("close", () => {
      // Resolve any pending mark promises so sendAudio doesn't hang on unexpected disconnect
      for (const resolve of this.pendingMarks.values()) resolve();
      this.pendingMarks.clear();
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

        // EOT logging: record every webhook with relative timing
        const relMs = this.eotRelMs();
        this.webhookLog.push({ type: eventType, relativeMs: relMs, detail: (event.message ?? "") as string });
        console.log(`[bland-eot] webhook: type=${eventType} at +${relMs}ms`);

        if (eventType === "latency" || event.category === "latency") {
          // Bland sends latency as message strings like "LLM: 378ms", "TTS: 263ms (ttfa=263ms buffer_hold=0ms)"
          // Parse the message string to extract component timings
          const msg = (event.message ?? "") as string;
          const timing: ComponentLatency = {};

          const sttMatch = msg.match(/\bSTT[:\s]+(\d+)\s*ms/i);
          const llmMatch = msg.match(/\bLLM[:\s]+(\d+)\s*ms/i);
          const ttsMatch = msg.match(/\bTTS[:\s]+(\d+)\s*ms/i);

          if (sttMatch) timing.stt_ms = parseInt(sttMatch[1]!, 10);
          if (llmMatch) timing.llm_ms = parseInt(llmMatch[1]!, 10);
          if (ttsMatch) timing.tts_ms = parseInt(ttsMatch[1]!, 10);

          if (timing.stt_ms != null || timing.llm_ms != null || timing.tts_ms != null) {
            this.componentLatencies.push(timing);
            console.log(`[bland-eot] latency: STT=${timing.stt_ms ?? "?"}ms LLM=${timing.llm_ms ?? "?"}ms TTS=${timing.tts_ms ?? "?"}ms at +${relMs}ms`);
          }
        }

        // Capture dynamic_data events — fires when the agent fetches external API data
        if (eventType === "dynamic_data") {
          const data = (typeof event.data === "object" && event.data !== null ? event.data : event) as Record<string, unknown>;
          const name = (data.url ?? data.name ?? data.tool_name ?? "dynamic_data") as string;
          this.realtimeToolCalls.push({
            name,
            arguments: (data.request_data ?? data.params ?? {}) as Record<string, unknown>,
            result: data.response ?? data.result ?? data.response_data,
            successful: data.status === "success" || data.status_code === 200 || data.response != null,
            timestamp_ms: Date.now(),
          });
        }

        // Capture webhook events — fires on dynamic data storage confirmations
        if (eventType === "webhook") {
          const data = (typeof event.data === "object" && event.data !== null ? event.data : event) as Record<string, unknown>;
          const name = (data.url ?? data.name ?? data.tool_name ?? "webhook") as string;
          this.realtimeToolCalls.push({
            name,
            arguments: (data.request_data ?? data.params ?? {}) as Record<string, unknown>,
            result: data.response ?? data.result ?? data.response_data,
            successful: data.status === "success" || data.status_code === 200 || data.response != null,
            timestamp_ms: Date.now(),
          });
        }

        // Capture "Storing dynamic data" from call events — Bland stores webhook
        // responses as dynamic data variables (e.g. available_slots, booking_id)
        if (eventType === "call") {
          const msg = (event.message ?? "") as string;

          // EOT logging: track agent speech and user speech signals
          if (msg.startsWith("Agent speech:") || msg.startsWith("Handling user speech:")) {
            console.log(`[bland-eot] call-event: "${msg.slice(0, 100)}" at +${relMs}ms`);
          }

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
              timestamp_ms: Date.now(),
            });
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

      try {
        const event = JSON.parse(body) as Record<string, unknown>;
        console.log(`[bland] Tool webhook (${this.channelId}): ${JSON.stringify(event)}`);

        // Extract tool call info from the webhook event
        const name = (event.name ?? event.tool ?? event.tool_name ?? event.function_name ?? "unknown") as string;
        const args = (event.arguments ?? event.params ?? event.input ?? {}) as Record<string, unknown>;
        const result = event.result ?? event.response ?? event.output;
        const successful = event.status === "success" || event.status_code === 200 || result != null;

        this.realtimeToolCalls.push({
          name,
          arguments: args,
          result,
          successful,
          timestamp_ms: Date.now(),
        });
      } catch {
        // Ignore malformed payloads
      }
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
        // Log raw response for debugging tool calls and pathway_logs
        const logSummary = {
          status: data.status,
          transcript_count: data.transcripts?.length ?? 0,
          agent_actions: data.transcripts?.filter((t) => t.user === "agent-action").length ?? 0,
          pathway_log_count: data.pathway_logs?.length ?? 0,
          variables: data.variables ? Object.keys(data.variables) : [],
        };
        console.log(`[bland] Post-call response summary: ${JSON.stringify(logSummary)}`);
        if (data.pathway_logs?.length) {
          console.log(`[bland] Pathway logs: ${JSON.stringify(data.pathway_logs)}`);
        }

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

      const raw = await res.json() as unknown;

      // Response may be an array directly or { events: [...] }
      type EventEntry = { level?: string; message?: string; category?: string; log_level?: string };
      let events: EventEntry[];
      if (Array.isArray(raw)) {
        events = raw;
      } else if (raw && typeof raw === "object" && "events" in raw && Array.isArray((raw as { events: unknown }).events)) {
        events = (raw as { events: EventEntry[] }).events;
      } else {
        console.log(`[bland] Event stream: unexpected shape for ${this.callId}: ${JSON.stringify(raw).slice(0, 200)}`);
        return;
      }

      console.log(`[bland] Event stream: ${events.length} events for ${this.callId}`);

      for (const evt of events) {
        const isPerf = evt.category === "performance" || evt.log_level === "performance";
        if (isPerf && evt.message) {
          const timing: ComponentLatency = {};
          const sttMatch = evt.message.match(/\bSTT[:\s]+(\d+)\s*ms/i);
          const llmMatch = evt.message.match(/\bLLM[:\s]+(\d+)\s*ms/i);
          const ttsMatch = evt.message.match(/\bTTS[:\s]+(\d+)\s*ms/i);
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

    // 1. Parse agent-action transcript entries (inline tool calls)
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

    // 2. Parse pathway_logs for webhook node executions
    //    Bland pathway_logs contain: tag, role, text, decision (JSON string), pathway_info (JSON string),
    //    created_at, chosen_node_id. Webhook nodes are identified by chosen_node_id containing "webhook"
    //    and pathway_info containing the URL/response data.
    const pathwayLogs = data.pathway_logs ?? [];
    const seenWebhookNodes = new Set<string>();

    for (const log of pathwayLogs) {
      // Identify webhook node executions by chosen_node_id
      if (log.chosen_node_id && /webhook/i.test(log.chosen_node_id) && !seenWebhookNodes.has(log.chosen_node_id)) {
        seenWebhookNodes.add(log.chosen_node_id);
        // Extract name from node ID: "webhook_lookup_customer" → "lookup_customer"
        const name = log.chosen_node_id.replace(/^webhook[_-]?/i, "") || log.chosen_node_id;

        // Try to find response data from pathway_info
        let webhookResult: unknown = undefined;
        let webhookArgs: Record<string, unknown> = {};
        if (log.pathway_info) {
          try {
            const info = JSON.parse(log.pathway_info) as Record<string, unknown>;
            webhookResult = info.response ?? info.result ?? info;
            webhookArgs = (info.request_data ?? info.params ?? {}) as Record<string, unknown>;
          } catch { /* not JSON */ }
        }

        toolCalls.push({
          name,
          arguments: webhookArgs,
          result: webhookResult,
          successful: true,
          timestamp_ms: log.created_at ? new Date(log.created_at).getTime() : undefined,
        });
        continue;
      }

      // Also check pathway_info for URL-based webhook executions on non-webhook-named nodes
      if (log.pathway_info) {
        try {
          const info = JSON.parse(log.pathway_info) as Record<string, unknown>;
          if (typeof info.url === "string" || typeof info.webhook_url === "string") {
            const url = (info.url ?? info.webhook_url) as string;
            const name = log.chosen_node_id ?? log.tag?.name ?? url;
            toolCalls.push({
              name: name.replace(/\s+/g, "_").toLowerCase(),
              arguments: (info.request_data ?? info.params ?? info.body ?? {}) as Record<string, unknown>,
              result: info.response ?? info.result,
              successful: info.status_code === 200 || info.status === "success" || info.response != null,
              timestamp_ms: log.created_at ? new Date(log.created_at).getTime() : undefined,
            });
          }
        } catch { /* not JSON */ }
      }
    }

    // 3. Merge real-time tool call webhook events (collected during the call)
    //    Only add if not already captured from transcripts/pathway_logs (dedupe by name+timestamp proximity)
    for (const rtc of this.realtimeToolCalls) {
      const isDuplicate = toolCalls.some(
        (tc) => tc.name === rtc.name && tc.timestamp_ms && rtc.timestamp_ms &&
          Math.abs(tc.timestamp_ms - rtc.timestamp_ms) < 5000,
      );
      if (!isDuplicate) {
        toolCalls.push(rtc);
      }
    }

    return toolCalls;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip Bland-injected annotations like "<Block interruptions enabled. This message was ignored>" */
function stripBlandAnnotations(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}
