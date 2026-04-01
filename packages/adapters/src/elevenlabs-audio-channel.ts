/**
 * ElevenLabs Conversational AI Audio Channel (WebRTC)
 *
 * Connects directly to ElevenLabs' LiveKit Cloud via @livekit/rtc-node for
 * bidirectional audio. ElevenLabs uses LiveKit under the hood — we get a
 * LiveKit JWT from their token API and connect to wss://livekit.rtc.elevenlabs.io.
 *
 * Flow:
 *   1. connect()  — GET /v1/convai/conversation/token → LiveKit room.connect
 *   2. sendAudio() / on("audio") — bidirectional PCM 24kHz over WebRTC (48kHz internal)
 *   3. disconnect() — leaves room, ElevenLabs manages cleanup
 *   4. getCallData() — fetches tool calls via SDK conversations.get()
 *   5. getCallMetadata() — cost, duration, analysis
 *   6. getComponentTimings() — LLM TTFB from transcript turn metrics
 *   7. getTranscripts() — platform STT transcripts for cross-referencing
 *
 * Post-call data (tool calls, metadata, latency) fetched via SDK
 * client.conversationalAi.conversations.get().
 */

import {
  Room,
  RoomEvent,
  AudioSource,
  AudioStream,
  AudioFrame,
  LocalAudioTrack,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  IceTransportType,
  ContinualGatheringPolicy,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "@livekit/rtc-node";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { ObservedToolCall, CallMetadata, ComponentLatency, CostBreakdown } from "@vent/shared";
import { resample } from "@vent/voice";
import { BaseAudioChannel } from "./audio-channel.js";

export interface ElevenLabsAudioChannelConfig {
  apiKey: string;
  agentId: string;
}

export class ElevenLabsAudioChannel extends BaseAudioChannel {
  private static readonly ELEVENLABS_LIVEKIT_URL = "wss://livekit.rtc.elevenlabs.io";
  private static readonly ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io";
  private static readonly AGENT_IDENTITY_PREFIX = "agent";
  private static readonly LIVEKIT_SAMPLE_RATE = 48000;
  private static readonly AGENT_READY_TIMEOUT = 30_000;

  /** ElevenLabs signals agent speech via DataChannel events. */
  hasPlatformEndOfTurn = true;

  private config: ElevenLabsAudioChannelConfig;
  private client: ElevenLabsClient;

  // LiveKit room state
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private collecting = false;
  private comfortNoiseActive = false;

  // Call state
  private conversationId: string | null = null;
  private cachedConversation: Record<string, unknown> | null = null;
  private connectTimestamp = 0;
  private disconnectTimestamp = 0;

  // Real-time agent text from DataChannel events
  private agentTextBuffer = "";

  constructor(config: ElevenLabsAudioChannelConfig) {
    super();
    this.config = config;
    this.client = new ElevenLabsClient({ apiKey: config.apiKey });
  }

  get connected(): boolean {
    return this.room !== null && this.collecting;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();

    // Get LiveKit JWT from ElevenLabs token API
    const tokenUrl = `${ElevenLabsAudioChannel.ELEVENLABS_API_ORIGIN}/v1/convai/conversation/token?agent_id=${this.config.agentId}`;
    const tokenRes = await fetch(tokenUrl, {
      headers: { "xi-api-key": this.config.apiKey },
    });
    if (!tokenRes.ok) {
      throw new Error(
        `ElevenLabs token API returned ${tokenRes.status}: ${await tokenRes.text()}`
      );
    }
    const { token } = (await tokenRes.json()) as { token: string };
    if (!token) {
      throw new Error("ElevenLabs token API returned no token");
    }

    // Connect to ElevenLabs' LiveKit Cloud
    this.room = new Room();

    // On Fly.io, force TURN relay (same as Retell/LiveKit adapters)
    const isFlyIo = !!process.env["FLY_MACHINE_ID"];
    const rtcConfig = isFlyIo
      ? {
          iceTransportType: IceTransportType.TRANSPORT_RELAY,
          continualGatheringPolicy: ContinualGatheringPolicy.GATHER_CONTINUALLY,
          iceServers: [],
        }
      : undefined;

    await this.room.connect(ElevenLabsAudioChannel.ELEVENLABS_LIVEKIT_URL, token, {
      autoSubscribe: true,
      dynacast: true,
      rtcConfig,
    });
    this.collecting = true;
    this.connectTimestamp = Date.now();

    // Extract conversationId from room name (e.g. "conv_abc123...")
    if (this.room.name) {
      this.conversationId = this.room.name.match(/(conv_[a-zA-Z0-9]+)/)?.[0] ?? this.room.name;
    }

    // ── DataChannel listener for ElevenLabs JSON events ──────────
    this.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant) => {
        if (participant && !participant.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX)) return;
        this.handleDataEvent(payload);
      }
    );

    // ── Disconnect detection ─────────────────────────────────────
    this.room.once(RoomEvent.Disconnected, () => {
      this.emit("disconnected");
    });

    // ── Publish audio track (48kHz, microphone source) ───────────
    this.audioSource = new AudioSource(ElevenLabsAudioChannel.LIVEKIT_SAMPLE_RATE, 1);
    this.localTrack = LocalAudioTrack.createAudioTrack("vent-tester", this.audioSource);
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(this.localTrack, publishOptions);

    // ── Comfort noise — keep Opus codec warm ─────────────────────
    this.startComfortNoise();

    // ── Send conversation initiation via DataChannel ─────────────
    const initMsg = JSON.stringify({
      type: "conversation_initiation_client_data",
      conversation_config_override: {},
    });
    await this.room.localParticipant!.publishData(
      Buffer.from(initMsg),
      { reliable: true }
    );

    // ── Subscribe to agent audio tracks ──────────────────────────
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX)) {
        for (const pub of participant.trackPublications.values()) {
          if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
            this.startReadingTrack(pub.track as RemoteTrack);
          }
        }
      }
    }

    this.room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (participant.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX) && pub.kind === TrackKind.KIND_AUDIO) {
          this.startReadingTrack(track);
        }
      }
    );

    // ── Wait for agent audio track ───────────────────────────────
    const agentReady = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ElevenLabsAudioChannel.AGENT_READY_TIMEOUT);

      // Check if already subscribed
      for (const p of this.room!.remoteParticipants.values()) {
        if (p.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX)) {
          for (const pub of p.trackPublications.values()) {
            if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
              clearTimeout(timer);
              resolve(true);
              return;
            }
          }
        }
      }

      // Wait for subscription
      const onTrackSubscribed = (_t: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (participant.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX) && pub.kind === TrackKind.KIND_AUDIO) {
          clearTimeout(timer);
          this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
          resolve(true);
        }
      };
      this.room!.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    });

    if (!agentReady) {
      throw new Error(
        `ElevenLabs agent did not publish audio within ${ElevenLabsAudioChannel.AGENT_READY_TIMEOUT / 1000}s. ` +
        `Ensure the agent (${this.config.agentId}) is configured correctly in ElevenLabs.`
      );
    }

    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  // ── Comfort noise ──────────────────────────────────────────────

  /**
   * Send low-level white noise to prevent Opus DTX mode.
   * Without this, Opus ramps bitrate from 0 → 40kbps over 20s when
   * real speech arrives after silence — the agent's VAD misses it.
   */
  startComfortNoise(): void {
    this.comfortNoiseActive = true;
    const sampleRate = ElevenLabsAudioChannel.LIVEKIT_SAMPLE_RATE;
    const chunkSamples = Math.floor(sampleRate * 0.02); // 20ms
    const AMPLITUDE = 400; // ~-30dBFS

    const sendLoop = async () => {
      while (this.comfortNoiseActive && this.audioSource) {
        const samples = new Int16Array(chunkSamples);
        for (let i = 0; i < chunkSamples; i++) {
          samples[i] = Math.floor((Math.random() * 2 - 1) * AMPLITUDE);
        }
        const frame = new AudioFrame(samples, sampleRate, 1, chunkSamples);
        try {
          await this.audioSource.captureFrame(frame);
        } catch {
          break; // AudioSource closed
        }
      }
    };
    sendLoop();
  }

  stopComfortNoise(): void {
    this.comfortNoiseActive = false;
    if (this.audioSource) {
      this.audioSource.clearQueue();
    }
  }

  // ── Audio I/O ──────────────────────────────────────────────────

  sendAudio(pcm: Buffer): void {
    if (!this.audioSource || !this.collecting) return;

    if (this.comfortNoiseActive) {
      this.stopComfortNoise();
    }

    this._stats.bytesSent += pcm.length;

    const sampleRate = ElevenLabsAudioChannel.LIVEKIT_SAMPLE_RATE;
    const resampled = resample(pcm, 24000, sampleRate);
    const samples = new Int16Array(
      resampled.buffer,
      resampled.byteOffset,
      resampled.length / 2
    );

    const audioSource = this.audioSource;
    const chunkSamples = Math.floor(sampleRate * 0.02); // 20ms = 960 samples at 48kHz

    (async () => {
      try {
        for (let offset = 0; offset < samples.length; offset += chunkSamples) {
          if (!this.collecting || !this.audioSource) return;
          const end = Math.min(offset + chunkSamples, samples.length);
          // CRITICAL: copy chunk into its own ArrayBuffer. AudioFrame.protoInfo()
          // uses the ENTIRE underlying ArrayBuffer, not the subarray view.
          const chunk = new Int16Array(samples.subarray(offset, end));
          const frame = new AudioFrame(chunk, sampleRate, 1, chunk.length);
          await audioSource.captureFrame(frame);
        }

        // 500ms trailing silence for agent VAD end-of-turn detection
        if (!this.collecting || !this.audioSource) return;
        const silenceSamples = Math.floor(sampleRate * 0.5);
        const silence = new Int16Array(silenceSamples);
        const silenceFrame = new AudioFrame(silence, sampleRate, 1, silenceSamples);
        await audioSource.captureFrame(silenceFrame);

        // Resume comfort noise between turns
        if (this.collecting && this.audioSource) {
          this.startComfortNoise();
        }
      } catch {
        // AudioSource closed during send — safe to ignore
      }
    })();
  }

  async disconnect(): Promise<void> {
    this.collecting = false;
    this.stopComfortNoise();
    this.disconnectTimestamp = Date.now();
    if (this.audioSource) {
      await this.audioSource.close();
      this.audioSource = null;
    }
    if (this.localTrack) {
      await this.localTrack.close();
      this.localTrack = null;
    }
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }
    // NOTE: Do NOT call dispose() — destroys global FFI runtime
  }

  // ── Post-call data ─────────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchConversation();
    if (!data) return [];
    return this.parseToolCalls(data);
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchConversation();
    if (!data) return null;

    const meta = data.metadata as Record<string, unknown> | undefined;
    const charging = meta?.charging as Record<string, unknown> | undefined;
    const analysis = data.analysis as Record<string, unknown> | undefined;

    // ElevenLabs cost unit is undocumented — llm_price appears to be USD,
    // call_charge unit is unclear. Pass through what we can.
    const costBreakdown: CostBreakdown | undefined = charging ? {
      llm_usd: charging.llmPrice as number | undefined,
    } : undefined;

    const callSuccessful = analysis?.callSuccessful as string | undefined;

    return {
      platform: "elevenlabs",
      ended_reason: meta?.terminationReason as string | undefined,
      duration_s: meta?.callDurationSecs as number | undefined,
      cost_breakdown: costBreakdown,
      summary: analysis?.transcriptSummary as string | undefined,
      call_successful: callSuccessful === "success" ? true
        : callSuccessful === "failure" ? false : undefined,
    };
  }

  getComponentTimings(): ComponentLatency[] {
    const data = this.cachedConversation;
    const transcript = data?.transcript as Array<Record<string, unknown>> | undefined;
    if (!transcript) return [];

    const timings: ComponentLatency[] = [];
    for (const msg of transcript) {
      if (msg.role !== "agent") continue;
      const turnMetrics = msg.conversationTurnMetrics as Record<string, unknown> | undefined;
      const metrics = turnMetrics?.metrics as Record<string, { elapsedTime?: number }> | undefined;
      if (!metrics) continue;

      // ElevenLabs metric keys are free-form (e.g. "convai_llm_service_ttfb").
      // Match by substring to handle varying key names.
      let llmMs: number | undefined;
      for (const [key, val] of Object.entries(metrics)) {
        if (key.includes("llm") && key.includes("ttfb") && val.elapsedTime != null) {
          llmMs = val.elapsedTime * 1000;
        }
      }

      if (llmMs != null) {
        timings.push({ llm_ms: llmMs });
      }
    }
    return timings;
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const data = this.cachedConversation;
    const transcript = data?.transcript as Array<Record<string, unknown>> | undefined;
    if (!transcript) return [];

    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const msg of transcript) {
      if (msg.role === "user" && typeof msg.message === "string") {
        transcripts.push({ turnIndex: callerTurnIndex, text: msg.message });
        callerTurnIndex++;
      } else if (msg.role === "agent") {
        callerTurnIndex++;
      }
    }
    return transcripts;
  }

  /** Consume accumulated real-time agent transcript text (resets buffer). */
  consumeAgentText(): string {
    const text = this.agentTextBuffer;
    this.agentTextBuffer = "";
    return text;
  }

  // ── Private helpers ────────────────────────────────────────────

  private handleDataEvent(payload: Uint8Array): void {
    try {
      const text = new TextDecoder().decode(payload);
      const event = JSON.parse(text) as { type: string; [key: string]: unknown };

      switch (event.type) {
        case "conversation_initiation_metadata": {
          // Backup: extract conversationId if room.name parsing failed
          const convId = event.conversation_id as string | undefined;
          if (convId && !this.conversationId) {
            this.conversationId = convId;
          }
          break;
        }

        case "agent_response": {
          // Real-time agent text: { agent_response_event: { agent_response: "..." } }
          const evt = event.agent_response_event as { agent_response?: string } | undefined;
          if (evt?.agent_response) {
            this.agentTextBuffer += (this.agentTextBuffer ? " " : "") + evt.agent_response;
          }
          // Agent speaking → emit speech start
          this.emit("platformSpeechStart");
          break;
        }

        case "interruption": {
          // Agent was interrupted — signals end of agent turn
          this.emit("platformEndOfTurn");
          break;
        }

        case "ping": {
          // Respond with pong to keep connection alive
          const pingEvt = event.ping_event as { event_id?: number } | undefined;
          if (pingEvt?.event_id != null && this.room?.localParticipant) {
            const pong = JSON.stringify({ type: "pong", event_id: pingEvt.event_id });
            this.room.localParticipant.publishData(
              Buffer.from(pong),
              { reliable: true }
            ).catch(() => {/* ignore */});
          }
          break;
        }

        case "audio":
          // Skip — audio flows through LiveKit audio tracks in WebRTC mode
          break;
      }
    } catch {
      // Ignore malformed data
    }
  }

  private async fetchConversation(): Promise<Record<string, unknown> | null> {
    if (this.cachedConversation) return this.cachedConversation;
    if (!this.conversationId) return null;

    // Poll with backoff — ElevenLabs transitions through "processing" before "done"
    const delays = [500, 1000, 2000];
    for (const delay of delays) {
      await sleep(delay);
      try {
        const data = await this.client.conversationalAi.conversations.get(this.conversationId) as unknown as Record<string, unknown>;
        const status = data.status as string | undefined;
        const transcript = data.transcript as unknown[] | undefined;
        if (status === "done" || status === "failed" || (transcript && transcript.length > 0)) {
          this.cachedConversation = data;
          return data;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private parseToolCalls(data: Record<string, unknown>): ObservedToolCall[] {
    const messages = data.transcript as Array<Record<string, unknown>> | undefined;
    if (!messages) return [];

    const toolCalls: ObservedToolCall[] = [];

    // Build result map keyed by tool_call_id
    const resultMap = new Map<string, { result?: unknown; error?: string; time?: number }>();
    for (const msg of messages) {
      const toolResults = msg.toolResults as Array<Record<string, unknown>> | undefined;
      if (toolResults) {
        for (const tr of toolResults) {
          const id = tr.toolCallId as string | undefined;
          if (id) {
            resultMap.set(id, {
              result: tr.result,
              error: tr.error as string | undefined,
              time: msg.timeInCallSecs as number | undefined,
            });
          }
        }
      }
    }

    for (const msg of messages) {
      const tcs = msg.toolCalls as Array<Record<string, unknown>> | undefined;
      if (!tcs) continue;

      for (const tc of tcs) {
        const name = tc.name as string;
        const params = tc.params as Record<string, unknown> | undefined;
        const toolCallId = tc.toolCallId as string | undefined;
        const resultEntry = toolCallId ? resultMap.get(toolCallId) : undefined;
        const timestampMs = msg.timeInCallSecs != null ? (msg.timeInCallSecs as number) * 1000 : undefined;
        const resultTimeMs = resultEntry?.time != null ? resultEntry.time * 1000 : undefined;

        toolCalls.push({
          name,
          arguments: params ?? {},
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

    return toolCalls;
  }

  private startReadingTrack(track: RemoteTrack): void {
    const sampleRate = ElevenLabsAudioChannel.LIVEKIT_SAMPLE_RATE;
    const stream = new AudioStream(track, sampleRate, 1);
    const reader = stream.getReader();

    const readLoop = async () => {
      try {
        while (this.collecting) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;

          const frameBuffer = Buffer.from(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength
          );
          this._stats.bytesReceived += frameBuffer.length;
          // Resample from LiveKit 48kHz → 24kHz for consumers
          const pcm24k = resample(frameBuffer, sampleRate, 24000);
          this.emit("audio", pcm24k);
        }
      } catch (err) {
        if (err instanceof Error) {
          this._stats.errorEvents.push(err.message);
        }
      }
    };

    readLoop();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
