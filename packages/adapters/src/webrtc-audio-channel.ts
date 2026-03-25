/**
 * WebRTC Audio Channel (LiveKit)
 *
 * Joins a LiveKit room, publishes audio via AudioSource, and
 * receives agent audio via AudioStream. Handles 24kHz <-> 48kHz
 * resampling internally (LiveKit uses 48kHz by default).
 *
 * Captures LiveKit agent observability data automatically broadcast to the room:
 *   - Agent state transitions (lk.agent.state) for component latency estimation
 *   - Transcription streams (lk.transcription) for platform STT transcripts
 *   - Tool call events via DataChannel on topic "vent:tool-calls"
 *   - Disconnect reason for call metadata
 *
 * Supports explicit agent dispatch via AgentDispatchClient when agentName is set.
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
  ParticipantKind,
  DisconnectReason,
  IceTransportType,
  ContinualGatheringPolicy,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  dispose,
} from "@livekit/rtc-node";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { resample } from "@vent/voice";
import type { ObservedToolCall, CallMetadata, ComponentLatency } from "@vent/shared";
import { BaseAudioChannel } from "./audio-channel.js";

interface WsToolCallEvent {
  type: "tool_call";
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  duration_ms?: number;
}

/** Per-turn timing from LiveKit agent state transitions + transcription streams */
interface LiveKitTurnTiming {
  audioSentAt?: number;
  /** Agent state → "thinking" (STT done, LLM processing) */
  thinkingAt?: number;
  /** First agent transcription chunk on lk.transcription (LLM first token) */
  firstAgentTextAt?: number;
  /** Agent state → "speaking" (TTS started) */
  speakingAt?: number;
  /** Agent state → "listening" (speech ended) */
  listeningAt?: number;
  /** User STT transcript from lk.transcription */
  userTranscript?: string;
}

export interface WebRtcAudioChannelConfig {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
  /** Sample rate for LiveKit audio. Default: 48000 */
  livekitSampleRate?: number;
  /** Optional agent name for explicit dispatch (required if agent uses agent_name registration) */
  agentName?: string;
}

export class WebRtcAudioChannel extends BaseAudioChannel {
  private static readonly TOOL_CALL_TOPIC = "vent:tool-calls";
  private static readonly TRANSCRIPTION_TOPIC = "lk.transcription";
  private static readonly AGENT_STATE_ATTR = "lk.agent.state";

  private config: WebRtcAudioChannelConfig;
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private livekitSampleRate: number;
  private collecting = false;
  private toolCalls: ObservedToolCall[] = [];
  private connectTimestamp = 0;

  // Component latency tracking from agent state transitions + transcriptions
  private turnTimings: LiveKitTurnTiming[] = [];
  private currentTurnIndex = -1;
  private disconnectTimestamp = 0;
  private agentIdentity: string | null = null;
  private disconnectReasonStr: string | null = null;

  // Segment-to-turn anchoring: lock each STT segment to the turn that was
  // active when the segment was first observed (interim or final).
  private segmentTurnMap = new Map<string, number>();
  private comfortNoiseActive = false;

  constructor(config: WebRtcAudioChannelConfig) {
    super();
    this.config = config;
    this.livekitSampleRate = config.livekitSampleRate ?? 48000;
  }

  get connected(): boolean {
    return this.room !== null;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    const token = new AccessToken(
      this.config.apiKey,
      this.config.apiSecret,
      { identity: "vent-tester" }
    );
    token.addGrant({
      roomJoin: true,
      room: this.config.roomName,
      roomCreate: true,
      canPublish: true,
      canSubscribe: true,
    });

    // Token-based dispatch: agent is dispatched atomically when the room is
    // created, eliminating the race between participant join and API dispatch.
    if (this.config.agentName) {
      token.roomConfig = new RoomConfiguration({
        agents: [
          new RoomAgentDispatch({ agentName: this.config.agentName }),
        ],
      });
    }

    const jwt = await token.toJwt();

    this.room = new Room();

    // On Fly.io (and other containerized environments), direct UDP is unreliable
    // because containers sit behind WireGuard tunnels and HTTP proxies. Force
    // TURN relay so LiveKit uses TURN/TLS (TCP:443) which works through any proxy.
    const isFlyIo = !!process.env["FLY_MACHINE_ID"];
    const rtcConfig = isFlyIo
      ? {
          iceTransportType: IceTransportType.TRANSPORT_RELAY,
          continualGatheringPolicy: ContinualGatheringPolicy.GATHER_CONTINUALLY,
          iceServers: [],
        }
      : undefined;

    await this.room.connect(this.config.livekitUrl, jwt, {
      autoSubscribe: true,
      dynacast: true,
      rtcConfig,
    });
    this.collecting = true;
    this.connectTimestamp = Date.now();
    this.toolCalls = [];
    this.turnTimings = [];
    this.currentTurnIndex = -1;
    this.segmentTurnMap.clear();

    // ── Tool call capture via DataChannel ──────────────────────
    this.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        if (topic === WebRtcAudioChannel.TOOL_CALL_TOPIC) {
          this.handleToolCallData(payload);
        }
      }
    );

    this.room.registerTextStreamHandler(WebRtcAudioChannel.TOOL_CALL_TOPIC, async (reader) => {
      const text = await reader.readAll();
      this.handleToolCallText(text);
    });

    // ── Agent state transitions (lk.agent.state) ──────────────
    this.room.on(
      RoomEvent.ParticipantAttributesChanged,
      (changedAttributes: Record<string, string>, participant: Participant) => {
        const agentState = changedAttributes[WebRtcAudioChannel.AGENT_STATE_ATTR];
        if (!agentState) return;

        // Use ParticipantKind for definitive agent identification
        if (participant.kind === ParticipantKind.AGENT) {
          this.agentIdentity = participant.identity;
        } else if (this.agentIdentity && participant.identity !== this.agentIdentity) {
          return; // Ignore non-agent participants
        }

        const now = Date.now();
        const turn = this.currentTurnIndex >= 0 ? this.turnTimings[this.currentTurnIndex] : undefined;
        if (!turn) return;

        switch (agentState) {
          case "thinking":
            turn.thinkingAt = now;
            break;
          case "speaking":
            turn.speakingAt = now;
            break;
          case "listening":
            if (turn.speakingAt) {
              turn.listeningAt = now;
              this.emit("platformEndOfTurn");
            }
            break;
        }
      }
    );

    // ── Transcription streams (lk.transcription) ──────────────
    this.room.registerTextStreamHandler(
      WebRtcAudioChannel.TRANSCRIPTION_TOPIC,
      async (reader, participantInfo) => {
        const isUser = participantInfo.identity === "vent-tester";
        const turn = this.currentTurnIndex >= 0 ? this.turnTimings[this.currentTurnIndex] : undefined;

        if (isUser) {
          // Segment-anchored transcript assignment.
          // Each STT utterance has a unique lk.segment_id shared across
          // interim and final streams. The first stream (interim) arrives
          // while the correct turn is still active. The final stream may
          // arrive later during a different turn. We lock the segment to
          // the turn on first sight, then assign the final text there.
          const segmentId = reader.info?.attributes?.["lk.segment_id"];
          const isFinal = reader.info?.attributes?.["lk.transcription_final"] === "true";

          if (segmentId) {
            // Lock segment to current turn on first observation
            if (!this.segmentTurnMap.has(segmentId)) {
              this.segmentTurnMap.set(segmentId, this.currentTurnIndex);
            }

            if (!isFinal) return; // Skip interim — only need text from final

            const anchoredTurnIdx = this.segmentTurnMap.get(segmentId)!;
            const anchoredTurn = anchoredTurnIdx >= 0 ? this.turnTimings[anchoredTurnIdx] : undefined;
            const text = await reader.readAll();
            if (anchoredTurn && text) {
              anchoredTurn.userTranscript = anchoredTurn.userTranscript
                ? `${anchoredTurn.userTranscript} ${text}`
                : text;
            }
          } else {
            // Fallback: no segment_id — use current turn (old behavior)
            if (!isFinal) return;
            const text = await reader.readAll();
            if (turn && text) {
              turn.userTranscript = turn.userTranscript
                ? `${turn.userTranscript} ${text}`
                : text;
            }
          }
        } else {
          // Agent transcription — capture first chunk timestamp for LLM latency
          let firstChunkCaptured = false;
          for await (const _chunk of reader) {
            if (!firstChunkCaptured && turn) {
              if (!turn.firstAgentTextAt) {
                turn.firstAgentTextAt = Date.now();
              }
              firstChunkCaptured = true;
            }
          }
        }
      }
    );

    // ── Disconnect reason capture ─────────────────────────────
    this.room.once(RoomEvent.Disconnected, (reason: DisconnectReason) => {
      this.disconnectReasonStr = DisconnectReason[reason] ?? "UNKNOWN";
    });

    // ── Audio source for publishing ───────────────────────────
    this.audioSource = new AudioSource(this.livekitSampleRate, 1);
    this.localTrack = LocalAudioTrack.createAudioTrack(
      "vent-tester",
      this.audioSource
    );
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(
      this.localTrack,
      publishOptions
    );

    // ── Comfort noise — keep Opus codec warm ────────────────
    // Without continuous audio frames, Opus enters DTX (silence) mode.
    // When real speech arrives minutes later, the codec ramps bitrate
    // linearly from 0 → 40kbps over 20s — the agent's VAD misses it.
    // Low-level white noise forces Opus to maintain a baseline bitrate.
    this.startComfortNoise();

    // Subscribe to existing remote audio tracks
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.kind === ParticipantKind.AGENT) {
        this.agentIdentity = participant.identity;
      }
      for (const pub of participant.trackPublications.values()) {
        if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
          this.startReadingTrack(pub.track as RemoteTrack);
        }
      }
    }

    // Subscribe to new remote audio tracks
    this.room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (participant.kind === ParticipantKind.AGENT && !this.agentIdentity) {
          this.agentIdentity = participant.identity;
        }
        if (pub.kind === TrackKind.KIND_AUDIO) {
          this.startReadingTrack(track);
        }
      }
    );

    // Wait for agent to reach "listening" state — this means:
    // 1. Agent has joined the room
    // 2. Agent has published its audio track
    // 3. AEC warmup is complete (~3s)
    // 4. Agent is ready to process audio input
    // Without this, we'd send audio during AEC warmup and the agent would ignore it.
    const AGENT_READY_TIMEOUT = 45_000;
    const agentReady = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), AGENT_READY_TIMEOUT);

      // Check if agent is already in "listening" state
      for (const p of this.room!.remoteParticipants.values()) {
        if (p.kind === ParticipantKind.AGENT) {
          this.agentIdentity = p.identity;
          const state = p.attributes?.[WebRtcAudioChannel.AGENT_STATE_ATTR];
          if (state === "listening") {
            clearTimeout(timer);
            resolve(true);
            return;
          }
        }
      }

      // Listen for state changes
      const onAttrsChanged = (attrs: Record<string, string>, participant: Participant) => {
        if (participant.kind !== ParticipantKind.AGENT) return;
        this.agentIdentity = participant.identity;
        const state = attrs[WebRtcAudioChannel.AGENT_STATE_ATTR];
        if (state === "listening") {
          clearTimeout(timer);
          this.room?.off(RoomEvent.ParticipantAttributesChanged, onAttrsChanged);
          resolve(true);
        }
      };
      this.room!.on(RoomEvent.ParticipantAttributesChanged, onAttrsChanged);
    });

    if (!agentReady) {
      throw new Error(
        `LiveKit agent did not reach "listening" state in room "${this.config.roomName}" within ${AGENT_READY_TIMEOUT / 1000}s. ` +
        `Ensure your agent is running and connected to ${this.config.livekitUrl}. ` +
        `If your agent uses agent_name in WorkerOptions, set "agent_name" in the platform config.`
      );
    }

    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  /**
   * Continuously send low-level white noise to keep Opus codec warm.
   * Without this, Opus enters DTX mode during greeting capture (~15-30s)
   * and when real speech arrives, bitrate ramps linearly from 0 → 40kbps
   * over 20s — the agent's VAD never detects speech.
   */
  private startComfortNoise(): void {
    this.comfortNoiseActive = true;
    const sampleRate = this.livekitSampleRate;
    const chunkSamples = Math.floor(sampleRate * 0.02); // 20ms
    const AMPLITUDE = 400; // ~-30dBFS — enough to keep Opus out of DTX

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

  private stopComfortNoise(): void {
    this.comfortNoiseActive = false;
    // Clear the AudioSource queue so comfort noise doesn't bleed into real audio
    if (this.audioSource) {
      this.audioSource.clearQueue();
    }
  }

  sendAudio(pcm: Buffer): void {
    if (!this.audioSource || !this.collecting) {
      return;
    }

    // Stop comfort noise before sending real speech
    if (this.comfortNoiseActive) {
      this.stopComfortNoise();
    }

    this._stats.bytesSent += pcm.length;

    // Track turn timing (same pattern as Vapi adapter)
    this.currentTurnIndex++;
    this.turnTimings[this.currentTurnIndex] = { audioSentAt: Date.now() };

    // Resample 24kHz → LiveKit sample rate (48kHz for WebRTC/Opus)
    const resampled = resample(pcm, 24000, this.livekitSampleRate);
    const samples = new Int16Array(
      resampled.buffer,
      resampled.byteOffset,
      resampled.length / 2
    );

    // Fire-and-forget: send frames in background so collectUntilEndOfTurn can start
    // immediately. captureFrame has backpressure (50ms internal buffer) so frames
    // are paced at real-time rate automatically.
    const audioSource = this.audioSource;
    const sampleRate = this.livekitSampleRate;
    const chunkSamples = Math.floor(sampleRate * 0.02); // 20ms = 960 samples at 48kHz

    (async () => {
      try {
        for (let offset = 0; offset < samples.length; offset += chunkSamples) {
          if (!this.collecting || !this.audioSource) return;
          const end = Math.min(offset + chunkSamples, samples.length);
          // CRITICAL: copy chunk into its own ArrayBuffer. AudioFrame.protoInfo()
          // uses `new Uint8Array(this.data.buffer)` which takes the ENTIRE underlying
          // ArrayBuffer — not the subarray view. Without copying, the FFI layer
          // receives wrong data and the agent hears garbage.
          const chunk = new Int16Array(samples.subarray(offset, end));
          const frame = new AudioFrame(chunk, sampleRate, 1, chunk.length);
          await this.audioSource.captureFrame(frame);
        }

        // Send 500ms of silence so the agent's VAD detects end-of-turn
        if (!this.collecting || !this.audioSource) return;
        const silenceSamples = Math.floor(sampleRate * 0.5);
        const silence = new Int16Array(silenceSamples);
        const silenceFrame = new AudioFrame(silence, sampleRate, 1, silenceSamples);
        await this.audioSource.captureFrame(silenceFrame);

        console.log(`[livekit] sendAudio complete: ${Math.ceil(samples.length / chunkSamples)} frames, ${pcm.length} source bytes`);

        // Resume comfort noise after speech ends. A real caller's mic
        // produces constant ambient noise — this keeps the agent's
        // VAD/STT pipeline warm between turns so the next utterance
        // isn't clipped. (See LiveKit agents#3261)
        if (this.collecting && this.audioSource) {
          this.startComfortNoise();
        }
      } catch {
        // AudioSource was closed during send (disconnect called mid-turn) — safe to ignore
      }
    })();
  }

  async disconnect(): Promise<void> {
    this.collecting = false;
    this.stopComfortNoise();
    this.disconnectTimestamp = Date.now();
    if (this.room) {
      this.room.unregisterTextStreamHandler(WebRtcAudioChannel.TOOL_CALL_TOPIC);
      try {
        this.room.unregisterTextStreamHandler(WebRtcAudioChannel.TRANSCRIPTION_TOPIC);
      } catch {
        // May not be registered if connect() failed partway
      }
    }
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
    // Delete the room so lingering agent sessions don't consume quota
    try {
      const roomSvc = new RoomServiceClient(
        this.config.livekitUrl,
        this.config.apiKey,
        this.config.apiSecret,
      );
      await roomSvc.deleteRoom(this.config.roomName);
    } catch {
      // Best-effort cleanup — don't fail the test if this errors
    }
    // NOTE: Do NOT call dispose() here — it destroys the global FFI runtime
    // and kills all other concurrent LiveKit sessions in this process.
    // Let process exit handle native cleanup.
  }

  // ── Post-call data ──────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    return this.toolCalls;
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const durationS = this.disconnectTimestamp && this.connectTimestamp
      ? (this.disconnectTimestamp - this.connectTimestamp) / 1000
      : undefined;

    return {
      platform: "livekit",
      ended_reason: this.disconnectReasonStr ?? undefined,
      duration_s: durationS,
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return this.turnTimings.map((t) => {
      const stt_ms = t.audioSentAt != null && t.thinkingAt != null
        ? t.thinkingAt - t.audioSentAt : undefined;

      // If transcription stream provided first-token timing, split LLM and TTS
      const llm_ms = t.thinkingAt != null && t.firstAgentTextAt != null
        ? t.firstAgentTextAt - t.thinkingAt : undefined;
      const tts_ms = t.firstAgentTextAt != null && t.speakingAt != null
        ? t.speakingAt - t.firstAgentTextAt : undefined;

      const speech_duration_ms = t.speakingAt != null && t.listeningAt != null
        ? t.listeningAt - t.speakingAt : undefined;

      return { stt_ms, llm_ms, tts_ms, speech_duration_ms };
    });
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    for (let i = 0; i < this.turnTimings.length; i++) {
      const t = this.turnTimings[i]!;
      if (t.userTranscript) {
        transcripts.push({ turnIndex: i, text: t.userTranscript });
      }
    }
    return transcripts;
  }

  // ── Private helpers ─────────────────────────────────────────

  private handleToolCallData(payload: Uint8Array): void {
    try {
      const text = new TextDecoder().decode(payload);
      this.handleToolCallText(text);
    } catch {
      // Ignore malformed data
    }
  }

  private handleToolCallText(text: string): void {
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

  private startReadingTrack(track: RemoteTrack): void {
    console.log(`[livekit] Subscribed to remote audio track`);
    const stream = new AudioStream(track, this.livekitSampleRate, 1);
    const reader = stream.getReader();
    let frameCount = 0;

    const readLoop = async () => {
      try {
        while (this.collecting) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;

          frameCount++;
          if (frameCount === 1) {
            console.log(`[livekit] First agent audio frame received (${frame.data.byteLength} bytes)`);
          }

          const frameBuffer = Buffer.from(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength
          );
          this._stats.bytesReceived += frameBuffer.length;
          // Resample from LiveKit rate → 24kHz for consumers
          const pcm24k = resample(frameBuffer, this.livekitSampleRate, 24000);
          this.emit("audio", pcm24k);
        }
      } catch (err) {
        // Stream closed
        if (err instanceof Error) {
          this._stats.errorEvents.push(err.message);
        }
      }
      console.log(`[livekit] Audio read loop ended after ${frameCount} frames`);
    };

    readLoop();
  }
}
