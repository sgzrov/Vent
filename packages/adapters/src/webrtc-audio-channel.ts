/**
 * WebRTC Audio Channel (LiveKit)
 *
 * Joins a LiveKit room, publishes audio via AudioSource, and
 * receives agent audio via AudioStream. Handles 24kHz <-> 48kHz
 * resampling internally (LiveKit uses 48kHz by default).
 *
 * Supports tool call capture via DataChannel on topic "voiceci:tool-calls".
 * Agents emit JSON tool call events via publishData() or sendText(),
 * and this adapter collects them for getCallData().
 *
 * Extracted from webrtc-voice-adapter.ts — no TTS/STT/silence logic.
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
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  dispose,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { resample } from "@voiceci/voice";
import type { ObservedToolCall } from "@voiceci/shared";
import { BaseAudioChannel } from "./audio-channel.js";

interface WsToolCallEvent {
  type: "tool_call";
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  duration_ms?: number;
}

export interface WebRtcAudioChannelConfig {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
  /** Sample rate for LiveKit audio. Default: 48000 */
  livekitSampleRate?: number;
}

export class WebRtcAudioChannel extends BaseAudioChannel {
  private static readonly TOOL_CALL_TOPIC = "voiceci:tool-calls";

  private config: WebRtcAudioChannelConfig;
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private livekitSampleRate: number;
  private collecting = false;
  private toolCalls: ObservedToolCall[] = [];
  private connectTimestamp = 0;

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
      { identity: "voiceci-tester" }
    );
    token.addGrant({
      roomJoin: true,
      room: this.config.roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    this.room = new Room();
    await this.room.connect(this.config.livekitUrl, jwt);
    this.collecting = true;
    this.connectTimestamp = Date.now();
    this.toolCalls = [];

    // Subscribe to DataChannel for tool call events
    this.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        if (topic === WebRtcAudioChannel.TOOL_CALL_TOPIC) {
          this.handleToolCallData(payload);
        }
      }
    );

    // Also handle agents using sendText() (DataStream API)
    this.room.registerTextStreamHandler(WebRtcAudioChannel.TOOL_CALL_TOPIC, async (reader) => {
      const text = await reader.readAll();
      this.handleToolCallText(text);
    });

    // Set up audio source for publishing
    this.audioSource = new AudioSource(this.livekitSampleRate, 1);
    this.localTrack = LocalAudioTrack.createAudioTrack(
      "voiceci-tester",
      this.audioSource
    );
    await this.room.localParticipant!.publishTrack(
      this.localTrack,
      new TrackPublishOptions()
    );

    // Subscribe to existing remote audio tracks
    for (const participant of this.room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
          this.startReadingTrack(pub.track as RemoteTrack);
        }
      }
    }

    // Subscribe to new remote audio tracks
    this.room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, pub: RemoteTrackPublication, _p: RemoteParticipant) => {
        if (pub.kind === TrackKind.KIND_AUDIO) {
          this.startReadingTrack(track);
        }
      }
    );

    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  sendAudio(pcm: Buffer): void {
    if (!this.audioSource) {
      throw new Error("WebRTC not connected");
    }

    this._stats.bytesSent += pcm.length;
    // Resample 24kHz → LiveKit sample rate
    const resampled = resample(pcm, 24000, this.livekitSampleRate);
    const samples = new Int16Array(
      resampled.buffer,
      resampled.byteOffset,
      resampled.length / 2
    );
    const frame = new AudioFrame(
      samples,
      this.livekitSampleRate,
      1,
      samples.length
    );
    this.audioSource.captureFrame(frame);
  }

  async disconnect(): Promise<void> {
    this.collecting = false;
    if (this.room) {
      this.room.unregisterTextStreamHandler(WebRtcAudioChannel.TOOL_CALL_TOPIC);
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
    dispose();
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    return this.toolCalls;
  }

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
    const stream = new AudioStream(track, this.livekitSampleRate, 1);
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
    };

    readLoop();
  }
}
