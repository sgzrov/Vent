/**
 * AudioChannel — low-level bidirectional audio pipe.
 *
 * Adapters implement this interface to provide raw PCM send/receive
 * over a specific transport (WebSocket, WebRTC). No TTS, STT,
 * or silence detection — that lives in the call executors.
 *
 * All audio is 16-bit signed PCM, 24kHz, mono unless otherwise noted
 * in the adapter (transport-specific resampling happens internally).
 */

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ObservedToolCall, ChannelStats, CallMetadata, ComponentLatency } from "@vent/shared";
import { resample } from "@vent/voice";

export interface AudioChannelEvents {
  audio: (chunk: Buffer) => void;
  error: (err: Error) => void;
  disconnected: () => void;
  /** Platform signals that the agent finished speaking (e.g. LiveKit agent state → "listening"). */
  platformEndOfTurn: () => void;
  /** Platform signals that the agent started/resumed speaking. */
  platformSpeechStart: () => void;
  /** Platform signals that a tool call started (true) or completed (false).
   *  When active, collectUntilEndOfTurn suspends VAD end-of-turn to avoid
   *  cutting off the agent's post-tool-call response. */
  toolCallActive: (active: boolean) => void;
}

export interface SendAudioOptions {
  /** When true, skip send guards (silence padding, mark await, clear).
   *  Use for audio actions (interrupt, noise injection) where timing matters. */
  raw?: boolean;
}

export interface CallRecording {
  body: Readable;
  contentType: string;
  extension: string;
  cleanup(): Promise<void>;
}

export interface LiveCallRecording {
  pcm: Readable;
  finalize(): Promise<void>;
  abort(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface AudioChannel {
  connect(): Promise<void>;
  /** Send raw PCM audio to the agent (16-bit 24kHz mono) */
  sendAudio(pcm: Buffer, opts?: SendAudioOptions): void | Promise<void>;
  /** Start sending low-level comfort noise to keep the line active during processing. */
  startComfortNoise?(): void;
  /** Stop comfort noise. */
  stopComfortNoise?(): void;
  /** Flush any buffered audio, add silence tail, and resume comfort noise.
   *  Call after all sendAudio() calls for a turn are complete. */
  flushAudioBuffer?(): Promise<void>;
  disconnect(): Promise<void>;
  readonly connected: boolean;
  readonly stats: ChannelStats;

  /** Get tool call data after call ends. Platform adapters pull from API, websocket returns collected events. */
  getCallData?(): Promise<ObservedToolCall[]>;
  /** Get platform call metadata (cost, ended reason, recording, analysis) after call ends. */
  getCallMetadata?(): Promise<CallMetadata | null>;
  /** Get per-turn component latency breakdown (STT/LLM/TTS) from platform events. */
  getComponentTimings?(): ComponentLatency[];
  /** Get a Vent-captured call recording when the provider does not expose one natively. */
  getCallRecording?(): Promise<CallRecording | null>;
  /** Get a live mixed PCM stream so callers can upload while the call is still in progress. */
  getLiveCallRecording?(): LiveCallRecording | null;
  /** Drop any local recording capture state when a fallback artifact is not needed. */
  discardCallRecording?(): Promise<void>;
  /** Get platform's own STT transcripts for cross-referencing with Vent's STT. */
  getTranscripts?(): Array<{ turnIndex: number; text: string }>;
  /** Get ALL caller speech as a single concatenated string. */
  getFullCallerTranscript?(): string;
  /** Consume accumulated real-time agent transcript text (resets buffer). Used as STT fallback. */
  consumeAgentText?(): string;
  /** Whether this adapter emits platformEndOfTurn events.
   *  When true, collectUntilEndOfTurn can defer to the platform signal over VAD. */
  hasPlatformEndOfTurn?: boolean;
  /** Optional quiet window after platformEndOfTurn before Vent starts the next turn.
   *  Some platforms signal end-of-turn slightly before playback has fully drained. */
  platformEndOfTurnDrainMs?: number;
  /** Grace period after platformEndOfTurn before starting the drain timer.
   *  Some platforms (Retell) fire agent_stop_talking between sentences, not just
   *  at end of full response. A longer settle window lets agent_start_talking
   *  cancel the resolution before we commit. Defaults to 500ms if unset. */
  platformEndOfTurnSettleMs?: number;
  /** Optional continuation window after a tool call completes.
   *  Some platforms briefly speak filler, wait for the tool result, then continue
   *  the same assistant turn after a short pause. */
  postToolCallContinuationMs?: number;
  /** Optional short continuation window after VAD says end-of-turn.
   *  Useful on platforms that sometimes pause briefly mid-thought before resuming. */
  postVadContinuationMs?: number;
  /** Which side should speak first when the call starts. If omitted, executor defaults to agent-first. */
  getOpeningSpeaker?(): Promise<"agent" | "caller" | null>;
  /** Expected assistant opening message, if the platform has a configured assistant-first greeting. */
  getExpectedOpeningMessage?(): Promise<string | null>;
  /** Hard platform call limit, if the platform exposes one in its runtime config. */
  getMaxCallDurationSeconds?(): Promise<number | null>;
  /** Optional adapter-specific normalization for caller speech before TTS/send.
   *  Useful when a transport is sensitive to pause-heavy sentence punctuation
   *  inside a single caller turn. */
  normalizeCallerTextForSpeech?(text: string): string;
  /** Adapter-preferred initial silence threshold for turn collection. */
  preferredSilenceThresholdMs?: number;
  /** Platform-reported concurrency limit (e.g. Vapi returns this on call creation). */
  platformConcurrencyLimit?: number | null;

  on<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this;
  off<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this;
  once<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this;
  emit<E extends keyof AudioChannelEvents>(event: E, ...args: Parameters<AudioChannelEvents[E]>): boolean;
}

export abstract class BaseAudioChannel extends EventEmitter implements AudioChannel {
  protected _stats: ChannelStats = {
    bytesSent: 0,
    bytesReceived: 0,
    errorEvents: [],
    connectLatencyMs: 0,
  };

  /**
   * No-listener audio buffer. Captures audio emitted whenever there are
   * zero "audio" listeners — not just initially, but also between turns
   * when the executor has detached one collector and not yet attached the
   * next one. Without this, any agent audio that arrives in the gap
   * (common when the agent responds while we're still in caller-TTS/
   * caller-send) gets emitted to zero listeners and silently dropped.
   *
   * Capped by INPUT_SAMPLE_RATE × 2 bytes/sample × NO_LISTENER_BUFFER_SECONDS
   * so a long listener-less gap can't grow unbounded. Oldest chunks are
   * evicted when the cap is hit.
   */
  private _earlyAudioBuffer: Buffer[] = [];
  private _earlyAudioBufferBytes = 0;
  private static readonly NO_LISTENER_BUFFER_SECONDS = 30;
  private _recordingCapture = new CallRecordingCapture();

  get stats(): ChannelStats {
    return this._stats;
  }

  /**
   * Override emit to buffer audio events whenever no "audio" listener is
   * attached. Fans out to real listeners otherwise.
   */
  emit<E extends keyof AudioChannelEvents>(event: E, ...args: Parameters<AudioChannelEvents[E]>): boolean {
    if (event === "audio" && this.listenerCount("audio") === 0) {
      const chunk = args[0] as Buffer;
      const cap = BaseAudioChannel.INPUT_SAMPLE_RATE * 2 * BaseAudioChannel.NO_LISTENER_BUFFER_SECONDS;
      this._earlyAudioBuffer.push(chunk);
      this._earlyAudioBufferBytes += chunk.length;
      while (this._earlyAudioBufferBytes > cap && this._earlyAudioBuffer.length > 1) {
        const evicted = this._earlyAudioBuffer.shift()!;
        this._earlyAudioBufferBytes -= evicted.length;
      }
      return true;
    }
    return super.emit(event, ...args);
  }

  /**
   * Override on to flush the buffered no-listener audio whenever any
   * listener attaches and the buffer is non-empty. Flushes via super.emit
   * on nextTick so every listener attached in the same tick (e.g. the
   * executor's feedSTT AND collectUntilEndOfTurn's VAD onAudio) receives
   * the buffered chunks, not just the first one to subscribe.
   */
  on<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this {
    super.on(event, listener);
    if (event === "audio" && this._earlyAudioBuffer.length > 0) {
      const buffered = this._earlyAudioBuffer;
      this._earlyAudioBuffer = [];
      this._earlyAudioBufferBytes = 0;
      process.nextTick(() => {
        for (const chunk of buffered) {
          super.emit("audio", chunk);
        }
      });
    }
    return this;
  }

  // ── Pipecat-style audio buffer ──────────────────────────────────
  // Accumulates resampled PCM across multiple sendAudio() calls.
  // Drains fixed 20ms frames via writeAudioFrame() in the background.
  // Adapters implement writeAudioFrame() to send one frame to their transport.
  private _audioBuffer = new Int16Array(0);
  private _audioQueue: { samples: Int16Array; sampleRate: number }[] = [];
  private _audioDrainRunning = false;
  private _audioDrainNotify: (() => void) | null = null;
  private _audioDrainStopping = false;
  protected _connectTimestampMs = 0;
  protected _connectMonotonicMs = 0;

  /** Input sample rate for all adapters (16-bit mono PCM). */
  static readonly INPUT_SAMPLE_RATE = 24000;

  /** Output sample rate — override in subclass if different from 24kHz. */
  protected outputSampleRate = 24000;

  /** Frame duration in ms for chunking. */
  protected frameDurationMs = 20;

  /** Pacing interval between frames (ms). 0 = no pacing (WebRTC backpressure).
   *  WebSocket adapters set to frameDurationMs/2 for 2x real-time delivery
   *  (Pipecat pattern: audio arrives ahead of playback to prevent underruns). */
  protected pacingIntervalMs = 0;

  /** Monotonic clock for self-correcting pacing (Pipecat _write_audio_sleep). */
  private _nextSendTime = 0;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract get connected(): boolean;

  /**
   * Write a single fixed-size audio frame to the transport.
   * Subclasses implement this for their specific transport (WebRTC, WebSocket).
   * The frame is already resampled to outputSampleRate and sized to frameDurationMs.
   */
  protected abstract writeAudioFrame(samples: Int16Array, sampleRate: number): Promise<void>;

  /**
   * Send PCM audio to the agent. Audio is resampled, buffered, and drained
   * as fixed-size frames via writeAudioFrame(). Safe to call with any buffer
   * size, any number of times (Pipecat-style).
   */
  sendAudio(pcm: Buffer, opts?: SendAudioOptions): void {
    this._stats.bytesSent += pcm.length;
    this.captureCallerAudio(pcm, performance.now() - this._connectMonotonicMs);

    // Resample input → output rate
    const resampled = resample(pcm, BaseAudioChannel.INPUT_SAMPLE_RATE, this.outputSampleRate);
    const newSamples = new Int16Array(
      resampled.buffer,
      resampled.byteOffset,
      resampled.length / 2,
    );

    // Append to persistent buffer
    const merged = new Int16Array(this._audioBuffer.length + newSamples.length);
    merged.set(this._audioBuffer);
    merged.set(newSamples, this._audioBuffer.length);
    this._audioBuffer = merged;

    // Slice fixed frames from the buffer into the queue
    const chunkSamples = Math.floor(this.outputSampleRate * this.frameDurationMs / 1000);
    while (this._audioBuffer.length >= chunkSamples) {
      const chunk = new Int16Array(this._audioBuffer.subarray(0, chunkSamples));
      this._audioQueue.push({ samples: chunk, sampleRate: this.outputSampleRate });
      this._audioBuffer = new Int16Array(this._audioBuffer.subarray(chunkSamples));
    }

    // Wake the drain loop
    this._audioDrainNotify?.();
    this._audioDrainNotify = null;

    // Start drain loop if not running
    if (!this._audioDrainRunning) {
      this._startAudioDrain();
    }
  }

  /**
   * Flush remaining audio buffer, add silence tail, and resume comfort noise.
   * Call after all sendAudio() calls for a turn are complete.
   */
  async flushAudioBuffer(): Promise<void> {
    // Flush remaining samples as a partial frame
    if (this._audioBuffer.length > 0) {
      const chunk = new Int16Array(this._audioBuffer);
      this._audioQueue.push({ samples: chunk, sampleRate: this.outputSampleRate });
      this._audioBuffer = new Int16Array(0);
    }

    // Add silence tail (500ms)
    const silenceSamples = Math.floor(this.outputSampleRate * 0.5);
    const silence = new Int16Array(silenceSamples);
    const silencePcm = Buffer.from(silence.buffer, silence.byteOffset, silence.byteLength);
    this.captureCallerAudio(silencePcm, performance.now() - this._connectMonotonicMs);
    this._audioQueue.push({ samples: silence, sampleRate: this.outputSampleRate });

    // Signal drain loop to exit after processing remaining queue
    this._audioDrainStopping = true;
    this._audioDrainNotify?.();
    this._audioDrainNotify = null;

    // Wait for drain loop to finish
    while (this._audioDrainRunning) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    this._audioDrainStopping = false;

    // Resume comfort noise (if adapter implements it)
    if ("startComfortNoise" in this && typeof (this as any).startComfortNoise === "function") {
      (this as any).startComfortNoise();
    }
  }

  /** Clear both the audio buffer/queue AND the transport's internal queue.
   *  Call on interruption to stop all pending audio immediately. */
  protected clearAudioBuffer(): void {
    this._audioBuffer = new Int16Array(0);
    this._audioQueue = [];
    this._nextSendTime = 0;
    this._audioDrainStopping = true;
    this._audioDrainNotify?.();
    this._audioDrainNotify = null;
    this.clearTransportQueue();
  }

  /** Clear the transport's internal queue (e.g. LiveKit AudioSource).
   *  Override in subclass. Base implementation is a no-op. */
  protected clearTransportQueue(): void {}

  private _startAudioDrain(): void {
    if (this._audioDrainRunning) return;
    this._audioDrainRunning = true;
    this._audioDrainStopping = false;
    this._nextSendTime = 0;

    (async () => {
      try {
        while (this.connected) {
          if (this._audioQueue.length > 0) {
            const { samples, sampleRate } = this._audioQueue.shift()!;
            await this.writeAudioFrame(samples, sampleRate);

            // Pipecat-style self-correcting clock pacing for WebSocket transports.
            // WebRTC adapters leave pacingIntervalMs = 0 (captureFrame has backpressure).
            if (this.pacingIntervalMs > 0) {
              const now = performance.now();
              const sleep = Math.max(0, this._nextSendTime - now);
              if (sleep > 0) {
                await new Promise<void>((r) => setTimeout(r, sleep));
              }
              this._nextSendTime = sleep === 0
                ? performance.now() + this.pacingIntervalMs
                : this._nextSendTime + this.pacingIntervalMs;
            }
          } else if (this._audioDrainStopping) {
            // Only exit when explicitly told to (flushAudioBuffer or disconnect)
            break;
          } else {
            // Wait for new frames — do NOT exit on empty buffer.
            // Streaming TTS sends chunks with gaps between them.
            await new Promise<void>((r) => {
              this._audioDrainNotify = r;
            });
          }
        }
      } catch {
        // Transport closed — safe to ignore
      }
      this._audioDrainRunning = false;
    })();
  }

  protected enableRecordingCapture(): void {
    // Recording capture is always available so the live upload path can
    // initialize before or immediately after connect without adapter-specific setup.
  }

  protected captureCallerAudio(pcm: Buffer, _startMs: number): void {
    this._recordingCapture.append("caller", pcm);
  }

  protected captureAgentAudio(pcm: Buffer, _startMs: number): void {
    this._recordingCapture.append("agent", pcm);
  }

  async getCallRecording(): Promise<CallRecording | null> {
    return this._recordingCapture.render();
  }

  getLiveCallRecording(): LiveCallRecording | null {
    return this._recordingCapture.getLiveRecording();
  }

  async discardCallRecording(): Promise<void> {
    await this._recordingCapture.discard();
  }
}

type CallSide = "caller" | "agent";
const CALL_RECORDING_SAMPLE_RATE = 24000;
const SILENCE_AMPLITUDE_THRESHOLD = 200;

/**
 * Pipecat-style call recording: two in-memory byte buffers kept in sync
 * via "pad-before-append". Mixed audio is streamed live when requested,
 * otherwise a post-call WAV can still be rendered from the mixed output.
 */
class CallRecordingCapture {
  private callerChunks = new PendingBuffer();
  private agentChunks = new PendingBuffer();
  private mixedChunks = new PendingBuffer();
  private callerBytes = 0;
  private agentBytes = 0;
  private callerSpeaking = false;
  private agentSpeaking = false;
  private finalized = false;
  private liveRecording: LiveRecordingStream | null = null;

  append(role: CallSide, pcm: Buffer): void {
    if (this.finalized || pcm.length === 0) return;
    const isSpeech = hasSpeech(pcm);

    if (role === "caller") {
      // Pad agent buffer to match caller position (only if agent is silent)
      if (!this.agentSpeaking && this.callerBytes > this.agentBytes) {
        const pad = Buffer.alloc(this.callerBytes - this.agentBytes);
        this.agentChunks.append(pad);
        this.agentBytes += pad.length;
      }
      this.callerChunks.append(pcm);
      this.callerBytes += pcm.length;
      this.callerSpeaking = isSpeech;
    } else {
      // Pad caller buffer to match agent position (only if caller is silent)
      if (!this.callerSpeaking && this.agentBytes > this.callerBytes) {
        const pad = Buffer.alloc(this.agentBytes - this.callerBytes);
        this.callerChunks.append(pad);
        this.callerBytes += pad.length;
      }
      this.agentChunks.append(pcm);
      this.agentBytes += pcm.length;
      this.agentSpeaking = isSpeech;
    }

    this.flushMixedAudio();
  }

  async render(): Promise<CallRecording | null> {
    if (this.liveRecording) return null;

    this.finalizeOutput();
    const mixed = this.mixedChunks.takeAll();
    if (mixed.length === 0) return null;

    const header = createWavHeader(mixed.length, CALL_RECORDING_SAMPLE_RATE);
    const wav = Buffer.concat([header, mixed]);

    return {
      body: Readable.from([wav]),
      contentType: "audio/wav",
      extension: "wav",
      cleanup: async () => this.discard(),
    };
  }

  async discard(): Promise<void> {
    this.finalized = true;
    this.resetBuffers();
    this.liveRecording?.abort();
    this.liveRecording = null;
  }

  getLiveRecording(): LiveCallRecording {
    if (!this.liveRecording) {
      this.liveRecording = new LiveRecordingStream();
      const bufferedMixed = this.mixedChunks.takeAll();
      if (bufferedMixed.length > 0) {
        this.liveRecording.enqueue(bufferedMixed);
      }
    }

    return {
      pcm: this.liveRecording.readable,
      finalize: async () => {
        this.finalizeOutput();
      },
      abort: async () => {
        this.finalized = true;
        this.liveRecording?.abort();
        this.resetBuffers();
      },
      cleanup: async () => {
        this.liveRecording?.cleanup();
        this.liveRecording = null;
        this.resetBuffers();
      },
    };
  }

  private finalizeOutput(): void {
    if (this.finalized) return;
    this.finalized = true;

    const remaining = this.callerChunks.byteLength - this.agentChunks.byteLength;
    if (remaining > 0) {
      this.agentChunks.append(Buffer.alloc(remaining));
    } else if (remaining < 0) {
      this.callerChunks.append(Buffer.alloc(-remaining));
    }

    this.flushMixedAudio();
    this.liveRecording?.finish();
  }

  private flushMixedAudio(): void {
    const readyBytes = Math.min(this.callerChunks.byteLength, this.agentChunks.byteLength);
    if (readyBytes <= 0) return;

    const callerBuf = this.callerChunks.take(readyBytes);
    const agentBuf = this.agentChunks.take(readyBytes);
    const mixed = mixPcm16(callerBuf, agentBuf, readyBytes);

    if (this.liveRecording) {
      this.liveRecording.enqueue(mixed);
      return;
    }

    this.mixedChunks.append(mixed);
  }

  private resetBuffers(): void {
    this.callerChunks.clear();
    this.agentChunks.clear();
    this.mixedChunks.clear();
    this.callerBytes = 0;
    this.agentBytes = 0;
    this.callerSpeaking = false;
    this.agentSpeaking = false;
  }
}

class PendingBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  get byteLength(): number {
    return this.totalBytes;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  take(byteLength: number): Buffer {
    if (byteLength <= 0 || this.totalBytes === 0) return Buffer.alloc(0);

    const parts: Buffer[] = [];
    let remaining = Math.min(byteLength, this.totalBytes);

    while (remaining > 0 && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      if (head.length <= remaining) {
        parts.push(head);
        this.chunks.shift();
        this.totalBytes -= head.length;
        remaining -= head.length;
        continue;
      }

      parts.push(head.subarray(0, remaining));
      this.chunks[0] = head.subarray(remaining);
      this.totalBytes -= remaining;
      remaining = 0;
    }

    return Buffer.concat(parts);
  }

  takeAll(): Buffer {
    return this.take(this.totalBytes);
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}

class LiveRecordingReadable extends Readable {
  private queued: Buffer[] = [];
  private ended = false;
  private streamClosed = false;

  _read(): void {
    this.drain();
  }

  enqueue(chunk: Buffer): void {
    if (this.streamClosed || chunk.length === 0) return;
    this.queued.push(chunk);
    this.drain();
  }

  finish(): void {
    if (this.streamClosed) return;
    this.ended = true;
    this.drain();
  }

  abort(): void {
    if (this.streamClosed) return;
    this.queued = [];
    this.ended = true;
    this.streamClosed = true;
    this.push(null);
  }

  cleanup(): void {
    this.queued = [];
    this.ended = true;
    this.streamClosed = true;
    if (!this.destroyed) {
      this.destroy();
    }
  }

  private drain(): void {
    if (this.streamClosed) return;

    while (this.queued.length > 0) {
      const chunk = this.queued[0]!;
      const accepted = this.push(chunk);
      this.queued.shift();
      if (!accepted) return;
    }

    if (this.ended) {
      this.streamClosed = true;
      this.push(null);
    }
  }
}

class LiveRecordingStream {
  readonly readable = new LiveRecordingReadable();

  enqueue(chunk: Buffer): void {
    this.readable.enqueue(chunk);
  }

  finish(): void {
    this.readable.finish();
  }

  abort(): void {
    this.readable.abort();
  }

  cleanup(): void {
    this.readable.cleanup();
  }
}

function hasSpeech(pcm: Buffer): boolean {
  const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  for (let i = 0; i < int16.length; i++) {
    if (Math.abs(int16[i]!) > SILENCE_AMPLITUDE_THRESHOLD) return true;
  }
  return false;
}

function mixPcm16(a: Buffer, b: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 2) {
    const sa = i < a.length ? a.readInt16LE(i) : 0;
    const sb = i < b.length ? b.readInt16LE(i) : 0;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sa + sb)), i);
  }
  return out;
}

function createWavHeader(dataSize: number, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}
