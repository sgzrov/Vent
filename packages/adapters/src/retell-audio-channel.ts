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
import { BaseAudioChannel, type SendAudioOptions } from "./audio-channel.js";

const RAW_INTERRUPT_TRAILING_SILENCE_MS = 160;

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

  /** WebRTC audio frames lag behind DataChannel signals — wait for the audio tail
   *  to fully drain before resolving the turn, otherwise STT truncates. */
  platformEndOfTurnDrainMs = 500;

  /** Retell fires agent_stop_talking between sentences, not just at end of full
   *  response. A 1500ms settle window lets agent_start_talking cancel before we
   *  commit to resolving the turn. */
  platformEndOfTurnSettleMs = 1500;

  private config: RetellAudioChannelConfig;
  private client: Retell;

  // LiveKit room state
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private collecting = false;
  private comfortNoiseActive = false;

  // ── Pipecat-style audio buffer ──────────────────────────────────
  // Accumulates PCM bytes across multiple sendAudio() calls.
  // Drains fixed 20ms frames to LiveKit via a background task.
  // This allows streaming TTS chunks of any size without alignment issues.
  private audioBuffer: Int16Array = new Int16Array(0);
  private audioQueue: AudioFrame[] = [];
  private audioDrainActive = false;
  private audioDrainNotify: (() => void) | null = null;
  private audioDrainRunning = false;

  // Call state
  private callId: string | null = null;
  private cachedCallResponse: CallResponse | null = null;
  private connectTimestamp = 0;
  private disconnectTimestamp = 0;

  // Real-time agent text from DataChannel "update" events
  private agentTextBuffer = "";
  private lastAgentContent = "";
  private realtimeUserTranscripts: string[] = [];
  private lastUserContent = "";
  private realtimeToolCallEntries = new Map<string, Record<string, unknown>>();

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
    this.enableRecordingCapture();

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
    this.agentTextBuffer = "";
    this.lastAgentContent = "";
    this.realtimeUserTranscripts = [];
    this.lastUserContent = "";
    this.realtimeToolCallEntries.clear();

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
      // Define listener first so timeout cleanup can reference it
      const onTrackSubscribed = (_t: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (participant.identity === RetellAudioChannel.SERVER_IDENTITY && pub.kind === TrackKind.KIND_AUDIO) {
          clearTimeout(timer);
          this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
          resolve(true);
        }
      };

      const timer = setTimeout(() => {
        this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
        resolve(false);
      }, RetellAudioChannel.AGENT_READY_TIMEOUT);

      // Check if already subscribed
      for (const p of this.room!.remoteParticipants.values()) {
        if (p.identity === RetellAudioChannel.SERVER_IDENTITY) {
          for (const pub of p.trackPublications.values()) {
            if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
              clearTimeout(timer);
              this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
              resolve(true);
              return;
            }
          }
        }
      }

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
    // Clear the audio buffer on interruption/stop (like Pipecat's _bot_stopped_speaking)
    this.audioBuffer = new Int16Array(0);
    this.audioQueue = [];
    if (this.audioSource) {
      this.audioSource.clearQueue();
    }
  }

  // ── Audio I/O ──────────────────────────────────────────────────

  /**
   * Send PCM audio to the agent. Audio is buffered and drained as fixed
   * 20ms WebRTC frames via a background task (Pipecat-style).
   * Safe to call with any buffer size, any number of times.
   */
  sendAudio(pcm: Buffer, opts?: SendAudioOptions): void {
    if (!this.audioSource || !this.collecting) return;
    const raw = opts?.raw ?? false;

    if (this.comfortNoiseActive) {
      this.stopComfortNoise();
    } else if (raw) {
      this.audioSource.clearQueue();
      // For raw sends (interrupts), bypass the buffer and send directly
      // to avoid latency from the drain loop.
      this._sendDirect(pcm, raw);
      return;
    }

    this._stats.bytesSent += pcm.length;
    this.captureCallerAudio(pcm, Date.now() - this.connectTimestamp);

    // Resample 24kHz → 48kHz and accumulate into the audio buffer
    const sampleRate = RetellAudioChannel.LIVEKIT_SAMPLE_RATE;
    const resampled = resample(pcm, 24000, sampleRate);
    const newSamples = new Int16Array(
      resampled.buffer,
      resampled.byteOffset,
      resampled.length / 2
    );

    // Append to persistent buffer (like Pipecat's _audio_buffer bytearray)
    const merged = new Int16Array(this.audioBuffer.length + newSamples.length);
    merged.set(this.audioBuffer);
    merged.set(newSamples, this.audioBuffer.length);
    this.audioBuffer = merged;

    // Slice fixed 20ms frames from the buffer into the queue
    const chunkSamples = Math.floor(sampleRate * 0.02); // 960 samples at 48kHz
    while (this.audioBuffer.length >= chunkSamples) {
      // CRITICAL: copy chunk into its own ArrayBuffer. AudioFrame.protoInfo()
      // uses the ENTIRE underlying ArrayBuffer, not the subarray view.
      const chunk = new Int16Array(this.audioBuffer.subarray(0, chunkSamples));
      const frame = new AudioFrame(chunk, sampleRate, 1, chunk.length);
      this.audioQueue.push(frame);
      this.audioBuffer = this.audioBuffer.subarray(chunkSamples);
      // Reallocate to avoid holding onto the old large buffer
      if (this.audioBuffer.length > 0) {
        this.audioBuffer = new Int16Array(this.audioBuffer);
      }
    }

    // Wake up the drain loop
    this.audioDrainNotify?.();
    this.audioDrainNotify = null;

    // Start drain loop if not running
    if (!this.audioDrainRunning) {
      this._startAudioDrain();
    }
  }

  /**
   * Signal that all audio for this utterance has been sent.
   * Flushes remaining buffer, adds silence tail, and starts comfort noise.
   */
  async flushAudioBuffer(): Promise<void> {
    // Flush any remaining samples as a partial frame
    if (this.audioBuffer.length > 0) {
      const sampleRate = RetellAudioChannel.LIVEKIT_SAMPLE_RATE;
      const chunk = new Int16Array(this.audioBuffer);
      const frame = new AudioFrame(chunk, sampleRate, 1, chunk.length);
      this.audioQueue.push(frame);
      this.audioBuffer = new Int16Array(0);
    }

    // Add silence tail (500ms)
    const sampleRate = RetellAudioChannel.LIVEKIT_SAMPLE_RATE;
    const silenceSamples = Math.floor(sampleRate * 0.5);
    const silence = new Int16Array(silenceSamples);
    const silenceFrame = new AudioFrame(silence, sampleRate, 1, silenceSamples);
    this.audioQueue.push(silenceFrame);

    // Wake drain and wait for it to finish
    this.audioDrainNotify?.();
    this.audioDrainNotify = null;

    // Wait for queue to drain
    while (this.audioQueue.length > 0) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // Resume comfort noise
    if (this.collecting && this.audioSource) {
      this.startComfortNoise();
    }
  }

  /** Background task that drains audio queue into LiveKit AudioSource. */
  private _startAudioDrain(): void {
    if (this.audioDrainRunning) return;
    this.audioDrainRunning = true;

    (async () => {
      try {
        while (this.collecting && this.audioSource) {
          if (this.audioQueue.length > 0) {
            const frame = this.audioQueue.shift()!;
            await this.audioSource.captureFrame(frame);
          } else {
            // Wait for new frames or timeout
            await new Promise<void>((r) => {
              this.audioDrainNotify = r;
              setTimeout(r, 100); // periodic wake
            });
            // If queue is still empty after wake, exit
            if (this.audioQueue.length === 0 && this.audioBuffer.length === 0) {
              break;
            }
          }
        }
      } catch {
        // AudioSource closed — safe to ignore
      }
      this.audioDrainRunning = false;
    })();
  }

  /** Direct send for raw/interrupt audio — bypasses buffer for low latency. */
  private _sendDirect(pcm: Buffer, raw: boolean): void {
    this._stats.bytesSent += pcm.length;
    this.captureCallerAudio(pcm, Date.now() - this.connectTimestamp);

    const sampleRate = RetellAudioChannel.LIVEKIT_SAMPLE_RATE;
    const resampled = resample(pcm, 24000, sampleRate);
    const samples = new Int16Array(
      resampled.buffer,
      resampled.byteOffset,
      resampled.length / 2
    );

    const audioSource = this.audioSource!;
    const chunkSamples = Math.floor(sampleRate * 0.02);

    (async () => {
      try {
        for (let offset = 0; offset < samples.length; offset += chunkSamples) {
          if (!this.collecting || !this.audioSource) return;
          const end = Math.min(offset + chunkSamples, samples.length);
          const chunk = new Int16Array(samples.subarray(offset, end));
          const frame = new AudioFrame(chunk, sampleRate, 1, chunk.length);
          await audioSource.captureFrame(frame);
        }

        if (!this.collecting || !this.audioSource) return;
        const silenceSamples = Math.floor(
          sampleRate * (RAW_INTERRUPT_TRAILING_SILENCE_MS / 1000)
        );
        const silence = new Int16Array(silenceSamples);
        const silenceFrame = new AudioFrame(silence, sampleRate, 1, silenceSamples);
        await audioSource.captureFrame(silenceFrame);
      } catch {
        // AudioSource closed — safe to ignore
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
    if (!data) return this.parseRealtimeToolCalls();
    const parsed = this.parseToolCalls(data);
    return parsed.length > 0 ? parsed : this.parseRealtimeToolCalls();
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchCallResponse();
    if (!data) {
      const providerMetadata = compactUnknownRecord({
        realtime_transcript_with_tool_calls:
          this.realtimeToolCallEntries.size > 0 ? [...this.realtimeToolCallEntries.values()] : undefined,
      });
      if (!this.callId && !providerMetadata) return null;
      return {
        platform: "retell",
        provider_call_id: this.callId ?? undefined,
        provider_metadata: providerMetadata,
      };
    }

    const cost = data.call_cost as { combined_cost?: number; product_costs?: Array<{ product: string; cost: number }> } | undefined;
    const dataRecord = data as unknown as Record<string, unknown>;
    const telephony = dataRecord["telephony_identifier"] as { twilio_call_sid?: string } | undefined;

    return {
      platform: "retell",
      provider_call_id: data.call_id ?? this.callId ?? undefined,
      provider_session_id: telephony?.twilio_call_sid,
      ended_reason: data.disconnection_reason ?? undefined,
      cost_usd: cost?.combined_cost != null ? cost.combined_cost / 100 : undefined,
      cost_breakdown: cost?.product_costs ? buildRetellCostBreakdown(cost.product_costs) : undefined,
      recording_url: data.recording_url ?? undefined,
      recording_variants: compactStringRecord({
        multi_channel: data.recording_multi_channel_url ?? undefined,
        scrubbed: data.scrubbed_recording_url ?? undefined,
        scrubbed_multi_channel: data.scrubbed_recording_multi_channel_url ?? undefined,
      }),
      provider_debug_urls: compactStringRecord({
        public_log: data.public_log_url ?? undefined,
        knowledge_base: data.knowledge_base_retrieved_contents_url ?? undefined,
      }),
      provider_metadata: compactUnknownRecord({
        duration_s: data.duration_ms != null ? data.duration_ms / 1000 : undefined,
        summary: data.call_analysis?.call_summary,
        user_sentiment: data.call_analysis?.user_sentiment,
        call_successful: data.call_analysis?.call_successful,
        custom_analysis_data: data.call_analysis?.custom_analysis_data,
        in_voicemail: data.call_analysis?.in_voicemail,
        llm_token_usage: data.llm_token_usage,
        telephony_identifier: telephony,
        metadata: data.metadata,
        scrubbed_transcript_with_tool_calls: data.scrubbed_transcript_with_tool_calls,
        e2e_latency: extractRetellE2eLatency(data),
      }),
      transfers: extractRetellTransfers(data),
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return extractRetellComponentTimings(this.cachedCallResponse);
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const data = this.cachedCallResponse;
    const entries = data?.transcript_with_tool_calls;
    if (!entries) {
      return this.realtimeUserTranscripts.map((text, turnIndex) => ({ turnIndex, text }));
    }

    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const entry of entries) {
      if (entry.role === "user" && "content" in entry) {
        transcripts.push({ turnIndex: callerTurnIndex, text: entry.content });
        callerTurnIndex++;
      }
    }
    return transcripts;
  }

  /** Full caller transcript for WER computation (avoids turn alignment issues). */
  getFullCallerTranscript(): string {
    return extractRetellCallerTranscript(this.cachedCallResponse) || this.realtimeUserTranscripts.join(" ");
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
              } else if (entry.role === "user" && entry.content !== this.lastUserContent) {
                this.realtimeUserTranscripts.push(entry.content);
                this.lastUserContent = entry.content;
              }
            }
          }
          this.captureRealtimeToolCallEntries(event);
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
    const entries = (data.transcript_with_tool_calls ?? [])
      .map((entry) => entry as unknown as Record<string, unknown>);
    return parseRetellToolCallsFromEntries(entries);
  }

  private parseRealtimeToolCalls(): ObservedToolCall[] {
    return parseRetellToolCallsFromEntries([...this.realtimeToolCallEntries.values()]);
  }

  private captureRealtimeToolCallEntries(event: Record<string, unknown>): void {
    const transcriptWithToolCalls =
      firstRecordArray(event["transcript_with_tool_calls"], event["transcriptWithToolCalls"]);
    if (!transcriptWithToolCalls) return;

    for (const entry of transcriptWithToolCalls) {
      const role = typeof entry["role"] === "string" ? entry["role"] : undefined;
      if (role !== "tool_call_invocation" && role !== "tool_call_result") continue;
      const toolCallId = typeof entry["tool_call_id"] === "string" ? entry["tool_call_id"] : undefined;
      if (!toolCallId) continue;
      const key = `${role}:${toolCallId}`;
      const prior = this.realtimeToolCallEntries.get(key);
      this.realtimeToolCallEntries.set(key, {
        ...(prior ?? {}),
        ...entry,
      });
    }
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

function parseRetellToolCallsFromEntries(entries: Record<string, unknown>[]): ObservedToolCall[] {
  const toolCalls: ObservedToolCall[] = [];
  const resultMap = new Map<string, { content: string; successful?: boolean }>();

  for (const entry of entries) {
    if (entry["role"] === "tool_call_result" && typeof entry["tool_call_id"] === "string") {
      resultMap.set(entry["tool_call_id"], {
        content: typeof entry["content"] === "string" ? entry["content"] : "",
        successful: typeof entry["successful"] === "boolean" ? entry["successful"] : undefined,
      });
    }
  }

  for (const entry of entries) {
    if (entry["role"] !== "tool_call_invocation") continue;
    const toolCallId = typeof entry["tool_call_id"] === "string" ? entry["tool_call_id"] : undefined;
    const name = typeof entry["name"] === "string" ? entry["name"] : undefined;
    if (!toolCallId || !name) continue;

    let args: Record<string, unknown> = {};
    if (typeof entry["arguments"] === "string") {
      try {
        args = JSON.parse(entry["arguments"]) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }

    const result = resultMap.get(toolCallId);
    let parsedResult: unknown;
    if (result) {
      try {
        parsedResult = JSON.parse(result.content);
      } catch {
        parsedResult = result.content;
      }
    }

    toolCalls.push({
      name,
      arguments: args,
      result: parsedResult,
      successful: result?.successful,
      provider_tool_type: typeof entry["type"] === "string"
        ? entry["type"]
        : typeof entry["tool_type"] === "string"
          ? entry["tool_type"]
          : undefined,
    });
  }

  return toolCalls;
}

function firstRecordArray(...values: unknown[]): Record<string, unknown>[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const records = value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
    if (records.length > 0) return records;
  }
  return undefined;
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

function extractRetellE2eLatency(data: CallResponse): Record<string, unknown> | undefined {
  const lat = data.latency as Record<string, { p50?: number; p90?: number; p95?: number; p99?: number; min?: number; max?: number; num?: number } | undefined> | undefined;
  const e2e = lat?.e2e;
  if (!e2e) return undefined;
  return {
    p50_ms: e2e.p50,
    p90_ms: e2e.p90,
    p95_ms: e2e.p95,
    p99_ms: e2e.p99,
    min_ms: e2e.min,
    max_ms: e2e.max,
    num_turns: e2e.num,
  };
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

function compactStringRecord(record: Record<string, string | undefined>): Record<string, string> | undefined {
  const compacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 0) {
      compacted[key] = value;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactUnknownRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
