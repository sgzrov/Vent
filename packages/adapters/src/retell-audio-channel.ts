/**
 * Retell Audio Channel (WebRTC)
 *
 * Connects directly to Retell's LiveKit Cloud via @livekit/rtc-node for
 * bidirectional audio. Uses Retell SDK for call creation and post-call data.
 * No Twilio or SIP dependency — pure WebRTC.
 *
 * Flow:
 *   1. connect()  — createWebCall → LiveKit room.connect with access_token
 *   2. sendAudio() / on("audio") — bidirectional PCM 24kHz over WebRTC (48kHz internal)
 *   3. disconnect() — leaves room, Retell manages cleanup
 *   4. getCallData() — fetches tool calls from SDK call.retrieve()
 *   5. getCallMetadata() — cost, latency, recording, analysis
 *   6. getComponentTimings() — STT/LLM/TTS latency with full percentiles
 *   7. getTranscripts() — platform STT transcripts for cross-referencing
 */

import Retell from "retell-sdk";
import type { CallResponse } from "retell-sdk/resources/call.js";
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
import { resample } from "@vent/voice";
import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency, CostBreakdown } from "@vent/shared";
import { BaseAudioChannel } from "./audio-channel.js";

export interface RetellAudioChannelConfig {
  apiKey: string;
  agentId: string;
}

export class RetellAudioChannel extends BaseAudioChannel {
  private static readonly RETELL_LIVEKIT_URL = "wss://retell-ai-4ihahnq7.livekit.cloud";
  private static readonly SERVER_IDENTITY = "server";
  private static readonly LIVEKIT_SAMPLE_RATE = 48000;
  private static readonly AGENT_READY_TIMEOUT = 30_000;

  /** Retell emits agent_stop_talking via DataChannel — reliable end-of-turn signal. */
  hasPlatformEndOfTurn = true;

  private config: RetellAudioChannelConfig;
  private client: Retell;

  // LiveKit room state
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private collecting = false;
  private comfortNoiseActive = false;

  // Call state
  private callId: string | null = null;
  private cachedCallResponse: CallResponse | null = null;
  private connectTimestamp = 0;
  private disconnectTimestamp = 0;

  // Real-time agent text from DataChannel "update" events
  private agentTextBuffer = "";
  private lastAgentContent = "";

  constructor(config: RetellAudioChannelConfig) {
    super();
    this.config = config;
    this.client = new Retell({ apiKey: config.apiKey });
  }

  get connected(): boolean {
    return this.room !== null && this.collecting;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();

    // Create web call — access_token has 30s TTL, must connect immediately
    const webCall = await this.client.call.createWebCall({
      agent_id: this.config.agentId,
    });
    this.callId = webCall.call_id;
    const accessToken = webCall.access_token;

    // Connect to Retell's LiveKit Cloud
    this.room = new Room();

    // On Fly.io, force TURN relay (same as LiveKit adapter)
    const isFlyIo = !!process.env["FLY_MACHINE_ID"];
    const rtcConfig = isFlyIo
      ? {
          iceTransportType: IceTransportType.TRANSPORT_RELAY,
          continualGatheringPolicy: ContinualGatheringPolicy.GATHER_CONTINUALLY,
          iceServers: [],
        }
      : undefined;

    await this.room.connect(RetellAudioChannel.RETELL_LIVEKIT_URL, accessToken, {
      autoSubscribe: true,
      dynacast: true,
      rtcConfig,
    });
    this.collecting = true;
    this.connectTimestamp = Date.now();

    // ── DataChannel listener for Retell JSON events ──────────────
    this.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, _topic?: string) => {
        if (participant?.identity !== RetellAudioChannel.SERVER_IDENTITY) return;
        this.handleRetellDataEvent(payload);
      }
    );

    // ── Disconnect detection ─────────────────────────────────────
    this.room.once(RoomEvent.Disconnected, () => {
      this.emit("disconnected");
    });

    // ── Publish audio track (48kHz, microphone source) ───────────
    this.audioSource = new AudioSource(RetellAudioChannel.LIVEKIT_SAMPLE_RATE, 1);
    this.localTrack = LocalAudioTrack.createAudioTrack("vent-tester", this.audioSource);
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(this.localTrack, publishOptions);

    // ── Comfort noise — keep Opus codec warm ─────────────────────
    this.startComfortNoise();

    // ── Subscribe to agent audio tracks ──────────────────────────
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.identity === RetellAudioChannel.SERVER_IDENTITY) {
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
        if (participant.identity === RetellAudioChannel.SERVER_IDENTITY && pub.kind === TrackKind.KIND_AUDIO) {
          this.startReadingTrack(track);
        }
      }
    );

    // ── Wait for agent audio track ───────────────────────────────
    const agentReady = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), RetellAudioChannel.AGENT_READY_TIMEOUT);

      // Check if already subscribed
      for (const p of this.room!.remoteParticipants.values()) {
        if (p.identity === RetellAudioChannel.SERVER_IDENTITY) {
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
        if (participant.identity === RetellAudioChannel.SERVER_IDENTITY && pub.kind === TrackKind.KIND_AUDIO) {
          clearTimeout(timer);
          this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
          resolve(true);
        }
      };
      this.room!.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    });

    if (!agentReady) {
      throw new Error(
        `Retell agent did not publish audio within ${RetellAudioChannel.AGENT_READY_TIMEOUT / 1000}s. ` +
        `Ensure the agent (${this.config.agentId}) is configured correctly in Retell.`
      );
    }

    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  /** Retell agents always speak first. */
  async getOpeningSpeaker(): Promise<"agent" | "caller" | null> {
    return "agent";
  }

  // ── Comfort noise ──────────────────────────────────────────────

  /**
   * Send low-level white noise to prevent Opus DTX mode.
   * Without this, Opus ramps bitrate from 0 → 40kbps over 20s when
   * real speech arrives after silence — the agent's VAD misses it.
   */
  startComfortNoise(): void {
    this.comfortNoiseActive = true;
    const sampleRate = RetellAudioChannel.LIVEKIT_SAMPLE_RATE;
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
    this.captureCallerAudio(pcm, Date.now() - this.connectTimestamp);

    const sampleRate = RetellAudioChannel.LIVEKIT_SAMPLE_RATE;
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
    // NOTE: Do NOT delete room — Retell manages their LiveKit rooms
  }

  // ── Post-call data ─────────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchCallResponse();
    if (!data) return [];
    return this.parseToolCalls(data);
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchCallResponse();
    if (!data) return null;

    const cost = data.call_cost as { combined_cost?: number; product_costs?: Array<{ product: string; cost: number }> } | undefined;

    return {
      platform: "retell",
      ended_reason: data.disconnection_reason ?? undefined,
      duration_s: data.duration_ms != null ? data.duration_ms / 1000 : undefined,
      cost_usd: cost?.combined_cost != null ? cost.combined_cost / 100 : undefined,
      cost_breakdown: cost?.product_costs ? buildRetellCostBreakdown(cost.product_costs) : undefined,
      recording_url: data.recording_url ?? undefined,
      summary: data.call_analysis?.call_summary ?? undefined,
      user_sentiment: data.call_analysis?.user_sentiment ?? undefined,
      call_successful: data.call_analysis?.call_successful ?? undefined,
      transfers: extractRetellTransfers(data),
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return extractRetellComponentTimings(this.cachedCallResponse);
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const data = this.cachedCallResponse;
    const entries = data?.transcript_with_tool_calls;
    if (!entries) return [];

    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const entry of entries) {
      if (entry.role === "user" && "content" in entry) {
        transcripts.push({ turnIndex: callerTurnIndex, text: entry.content });
        callerTurnIndex++;
      } else if (entry.role === "agent") {
        callerTurnIndex++;
      }
    }
    return transcripts;
  }

  /** Full caller transcript for WER computation (avoids turn alignment issues). */
  getFullCallerTranscript(): string {
    return extractRetellCallerTranscript(this.cachedCallResponse);
  }

  /** Consume accumulated real-time agent transcript text (resets buffer). */
  consumeAgentText(): string {
    const text = this.agentTextBuffer;
    this.agentTextBuffer = "";
    return text;
  }

  // ── Private helpers ────────────────────────────────────────────

  private handleRetellDataEvent(payload: Uint8Array): void {
    try {
      const text = new TextDecoder().decode(payload);
      const event = JSON.parse(text) as {
        event_type: string;
        transcript?: Array<{ role: string; content: string }>;
        [key: string]: unknown;
      };

      switch (event.event_type) {
        case "agent_stop_talking":
          this.emit("platformEndOfTurn");
          break;

        case "agent_start_talking":
          this.emit("platformSpeechStart");
          break;

        case "update":
          if (event.transcript) {
            // Extract latest agent text — transcript is a sliding window of last ~5 sentences
            for (const entry of event.transcript) {
              if (entry.role === "agent" && entry.content !== this.lastAgentContent) {
                this.agentTextBuffer += (this.agentTextBuffer ? " " : "") + entry.content;
                this.lastAgentContent = entry.content;
              }
            }
          }
          break;
      }
    } catch {
      // Ignore malformed data
    }
  }

  private async fetchCallResponse(): Promise<CallResponse | null> {
    if (this.cachedCallResponse) return this.cachedCallResponse;
    if (!this.callId) return null;

    // Poll with backoff — Retell needs time to process call data after disconnect
    const delays = [500, 1000, 2000];
    for (const delay of delays) {
      await sleep(delay);
      try {
        const data = await this.client.call.retrieve(this.callId);
        if (data.call_status === "ended" || data.call_status === "error" || data.transcript_with_tool_calls) {
          this.cachedCallResponse = data;
          return data;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private parseToolCalls(data: CallResponse): ObservedToolCall[] {
    const entries = data.transcript_with_tool_calls ?? [];
    const toolCalls: ObservedToolCall[] = [];

    // Build a map of results keyed by tool_call_id
    const resultMap = new Map<string, { content: string; successful?: boolean }>();
    for (const entry of entries) {
      if (entry.role === "tool_call_result") {
        resultMap.set(entry.tool_call_id, { content: entry.content, successful: entry.successful });
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

  private startReadingTrack(track: RemoteTrack): void {
    const sampleRate = RetellAudioChannel.LIVEKIT_SAMPLE_RATE;
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
          this.captureAgentAudio(pcm24k, Date.now() - this.connectTimestamp);
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

export function extractRetellComponentTimings(data: CallResponse | null | undefined): ComponentLatency[] {
  if (!data?.latency) return [];
  const lat = data.latency as Record<string, { values?: number[] } | undefined>;
  const sttValues = lat.asr?.values ?? [];
  const llmValues = lat.llm?.values ?? [];
  const ttsValues = lat.tts?.values ?? [];
  const maxLen = Math.max(sttValues.length, llmValues.length, ttsValues.length);
  if (maxLen === 0) return [];
  const timings: ComponentLatency[] = [];
  for (let i = 0; i < maxLen; i++) {
    timings.push({
      stt_ms: sttValues[i],
      llm_ms: llmValues[i],
      tts_ms: ttsValues[i],
    });
  }
  return timings;
}

export function extractRetellTransfers(data: CallResponse): CallTransfer[] | undefined {
  const disconnectionReason = data.disconnection_reason ?? undefined;
  const destination = data.transfer_destination ?? undefined;
  const looksTransferred =
    destination != null
    || disconnectionReason === "call_transfer"
    || disconnectionReason === "transfer_bridged"
    || disconnectionReason === "transfer_cancelled";

  if (!looksTransferred) return undefined;

  const status = resolveRetellTransferStatus(data);
  const transfer: CallTransfer = {
    type: disconnectionReason ?? "call_transfer",
    destination,
    status,
    sources: ["platform_metadata"],
  };
  const timestampMs = resolveRetellTransferTimestampMs(data);
  if (timestampMs != null) {
    transfer.timestamp_ms = timestampMs;
  }
  return [transfer];
}

function resolveRetellTransferStatus(data: Pick<CallResponse, "disconnection_reason" | "transfer_end_timestamp" | "transfer_destination">): CallTransfer["status"] {
  const reason = data.disconnection_reason ?? undefined;
  if (reason === "transfer_bridged") return "completed";
  if (reason === "transfer_cancelled") return "cancelled";
  if (reason === "call_transfer" && data.transfer_end_timestamp != null) return "completed";
  if (reason === "call_transfer" || data.transfer_destination != null) return "attempted";
  return "unknown";
}

export function resolveRetellTransferTimestampMs(data: Pick<CallResponse, "start_timestamp" | "transfer_end_timestamp">): number | undefined {
  if (data.transfer_end_timestamp != null && data.start_timestamp != null && data.transfer_end_timestamp >= data.start_timestamp) {
    return Math.round(data.transfer_end_timestamp - data.start_timestamp);
  }
  return undefined;
}

export function extractRetellCallerTranscript(
  data: Pick<CallResponse, "transcript_with_tool_calls"> | null | undefined,
): string {
  const entries = data?.transcript_with_tool_calls;
  if (!entries) return "";

  const callerTexts: string[] = [];
  for (const entry of entries) {
    if (entry.role === "user" && "content" in entry && typeof entry.content === "string") {
      callerTexts.push(entry.content);
    }
  }
  return callerTexts.join(" ");
}

export function buildRetellCostBreakdown(products: Array<{ product: string; cost: number }>): CostBreakdown {
  const breakdown: CostBreakdown = {};
  let total = 0;
  for (const p of products) {
    const usd = p.cost / 100;
    total += usd;
    const name = p.product.toLowerCase();
    if (name.includes("stt") || name.includes("asr") || name.includes("deepgram") || name.includes("whisper")) {
      breakdown.stt_usd = (breakdown.stt_usd ?? 0) + usd;
    } else if (name.includes("tts") || name.includes("elevenlabs") || name.includes("playht") || name.includes("cartesia")) {
      breakdown.tts_usd = (breakdown.tts_usd ?? 0) + usd;
    } else if (name.includes("llm") || name.includes("gpt") || name.includes("claude") || name.includes("openai")) {
      breakdown.llm_usd = (breakdown.llm_usd ?? 0) + usd;
    } else if (name.includes("transport") || name.includes("telephony") || name.includes("twilio")) {
      breakdown.transport_usd = (breakdown.transport_usd ?? 0) + usd;
    } else if (name.includes("retell") || name.includes("platform")) {
      breakdown.platform_usd = (breakdown.platform_usd ?? 0) + usd;
    }
  }
  breakdown.total_usd = total;
  return breakdown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
