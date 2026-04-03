/**
 * AudioChannel — low-level bidirectional audio pipe.
 *
 * Adapters implement this interface to provide raw PCM send/receive
 * over a specific transport (WebSocket, WebRTC, SIP). No TTS, STT,
 * or silence detection — that lives in the call executors.
 *
 * All audio is 16-bit signed PCM, 24kHz, mono unless otherwise noted
 * in the adapter (transport-specific resampling happens internally).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { open, mkdtemp, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ObservedToolCall, ChannelStats, CallMetadata, ComponentLatency } from "@vent/shared";
import { concatPcm } from "@vent/voice";

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
  /** When true, skip anti-echo measures (silence padding, mark await, clear).
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
  /** Get ALL caller speech as a single concatenated string (for WER without turn alignment). */
  getFullCallerTranscript?(): string;
  /** Consume accumulated real-time agent transcript text (resets buffer). Used as STT fallback. */
  consumeAgentText?(): string;
  /** Whether this adapter emits platformEndOfTurn events.
   *  When true, collectUntilEndOfTurn can defer to the platform signal over VAD. */
  hasPlatformEndOfTurn?: boolean;
  /** Optional quiet window after platformEndOfTurn before Vent starts the next turn.
   *  Some platforms signal end-of-turn slightly before playback has fully drained. */
  platformEndOfTurnDrainMs?: number;
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

  /** Early audio buffer — captures greeting audio before executor attaches listeners. */
  private _earlyAudioBuffer: Buffer[] = [];
  private _bufferingAudio = true;
  private _recordingCapture: CallRecordingCapture | null = null;

  get stats(): ChannelStats {
    return this._stats;
  }

  /**
   * Override emit to buffer audio events before any listener attaches.
   * This ensures agent greeting audio is never lost, regardless of adapter timing.
   */
  emit<E extends keyof AudioChannelEvents>(event: E, ...args: Parameters<AudioChannelEvents[E]>): boolean {
    if (event === "audio" && this._bufferingAudio) {
      this._earlyAudioBuffer.push(args[0] as Buffer);
      return true;
    }
    return super.emit(event, ...args);
  }

  /**
   * Override on to flush buffered greeting audio when the first audio listener attaches.
   */
  on<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this {
    super.on(event, listener);
    if (event === "audio" && this._bufferingAudio) {
      this._bufferingAudio = false;
      // Flush buffered greeting audio to the new listener on next tick
      // (so the listener is fully registered before receiving events)
      const buffered = this._earlyAudioBuffer;
      this._earlyAudioBuffer = [];
      process.nextTick(() => {
        for (const chunk of buffered) {
          (listener as AudioChannelEvents["audio"])(chunk);
        }
      });
    }
    return this;
  }

  abstract connect(): Promise<void>;
  abstract sendAudio(pcm: Buffer, opts?: SendAudioOptions): void | Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract get connected(): boolean;

  protected enableRecordingCapture(): void {
    if (!this._recordingCapture) {
      this._recordingCapture = new CallRecordingCapture();
    }
  }

  protected captureCallerAudio(pcm: Buffer, startMs: number): void {
    this._recordingCapture?.addSegment("caller", pcm, startMs);
  }

  protected captureAgentAudio(pcm: Buffer, startMs: number): void {
    this._recordingCapture?.addSegment("agent", pcm, startMs);
  }

  async getCallRecording(): Promise<CallRecording | null> {
    return this._recordingCapture?.render() ?? null;
  }

  getLiveCallRecording(): LiveCallRecording | null {
    return this._recordingCapture?.getLiveRecording() ?? null;
  }

  async discardCallRecording(): Promise<void> {
    await this._recordingCapture?.discard();
  }
}

type CallSide = "caller" | "agent";
const CALL_RECORDING_SAMPLE_RATE = 24000;
const CALL_RECORDING_MIX_CHUNK_BYTES = 64 * 1024;
const CALL_RECORDING_FLUSH_LAG_MS = 2_000;
const CALL_RECORDING_FLUSH_LAG_BYTES =
  Math.floor((CALL_RECORDING_SAMPLE_RATE * 2 * CALL_RECORDING_FLUSH_LAG_MS) / 1000);

class CallRecordingCapture {
  private caller = new RecordingSideWriter("caller");
  private agent = new RecordingSideWriter("agent");
  private tempDir: string | null = null;
  private tempDirPromise: Promise<string> | null = null;
  private liveMode = false;
  private liveQueue = new AsyncBufferQueue();
  private liveReadable: Readable | null = null;
  private flushedBytes = 0;
  private maxObservedBytes = 0;
  private flushPromise = Promise.resolve();
  private finalizePromise: Promise<void> | null = null;

  addSegment(role: CallSide, pcm: Buffer, startMs: number): void {
    const aligned = concatPcm([pcm]);
    if (aligned.length === 0) return;

    const startByte = Math.max(
      0,
      Math.round((startMs / 1000) * CALL_RECORDING_SAMPLE_RATE) * 2,
    );
    this.maxObservedBytes = Math.max(this.maxObservedBytes, startByte + aligned.length);

    void this.getWriter(role)
      .appendSegment(aligned, startMs, () => this.ensureTempDir())
      .then(() => this.flushEligible())
      .catch((err: unknown) => {
        this.liveQueue.fail(err instanceof Error ? err : new Error(String(err)));
      });
  }

  async render(): Promise<CallRecording | null> {
    await this.finalizeLive();
    const [{ filePath: callerPath, totalBytes: callerBytes }, { filePath: agentPath, totalBytes: agentBytes }] =
      await Promise.all([this.caller.finish(), this.agent.finish()]);

    const totalBytes = Math.max(callerBytes, agentBytes);
    if (totalBytes === 0) {
      await this.cleanupTempDir();
      return null;
    }

    const header = createWavHeader(totalBytes, CALL_RECORDING_SAMPLE_RATE);
    const body = Readable.from(this.mixToWavStream(header, callerPath, agentPath, totalBytes));

    return {
      body,
      contentType: "audio/wav",
      extension: "wav",
      cleanup: async () => this.discard(),
    };
  }

  async discard(): Promise<void> {
    this.liveQueue.close();
    await Promise.allSettled([this.caller.discard(), this.agent.discard()]);
    await this.cleanupTempDir();
  }

  getLiveRecording(): LiveCallRecording {
    this.liveMode = true;
    if (!this.liveReadable) {
      this.liveReadable = Readable.from(this.liveQueue);
    }

    return {
      pcm: this.liveReadable,
      finalize: async () => this.finalizeLive(),
      abort: async () => this.discard(),
      cleanup: async () => this.discard(),
    };
  }

  private getWriter(role: CallSide): RecordingSideWriter {
    return role === "caller" ? this.caller : this.agent;
  }

  private async ensureTempDir(): Promise<string> {
    if (this.tempDir) return this.tempDir;
    if (!this.tempDirPromise) {
      this.tempDirPromise = mkdtemp(join(tmpdir(), "vent-recording-")).then((dir) => {
        this.tempDir = dir;
        return dir;
      });
    }
    return this.tempDirPromise;
  }

  private async cleanupTempDir(): Promise<void> {
    const tempDir = this.tempDir ?? (this.tempDirPromise ? await this.tempDirPromise : null);
    if (!tempDir) return;
    this.tempDir = null;
    this.tempDirPromise = null;
    await rm(tempDir, { recursive: true, force: true });
  }

  private async *mixToWavStream(
    header: Buffer,
    callerPath: string | null,
    agentPath: string | null,
    totalBytes: number,
  ): AsyncGenerator<Buffer> {
    yield header;

    let callerHandle: FileHandle | null = null;
    let agentHandle: FileHandle | null = null;

    try {
      callerHandle = callerPath ? await open(callerPath, "r") : null;
      agentHandle = agentPath ? await open(agentPath, "r") : null;

      for (let offset = 0; offset < totalBytes; offset += CALL_RECORDING_MIX_CHUNK_BYTES) {
        const bytesToRead = Math.min(CALL_RECORDING_MIX_CHUNK_BYTES, totalBytes - offset);
        const chunkSize = bytesToRead % 2 === 0 ? bytesToRead : bytesToRead - 1;
        if (chunkSize <= 0) continue;

        const callerChunk = await readChunk(callerHandle, offset, chunkSize);
        const agentChunk = await readChunk(agentHandle, offset, chunkSize);
        yield mixPcmChunks(callerChunk, agentChunk);
      }
    } finally {
      await Promise.allSettled([callerHandle?.close(), agentHandle?.close()]);
    }
  }

  private async finalizeLive(): Promise<void> {
    if (!this.liveMode) return;
    if (!this.finalizePromise) {
      this.finalizePromise = (async () => {
        const [{ totalBytes: callerBytes }, { totalBytes: agentBytes }] = await Promise.all([
          this.caller.finish(),
          this.agent.finish(),
        ]);
        await this.flushTo(Math.max(callerBytes, agentBytes));
        this.liveQueue.close();
      })();
    }
    await this.finalizePromise;
  }

  private async flushEligible(): Promise<void> {
    if (!this.liveMode) return;
    const targetBytes = Math.max(0, this.maxObservedBytes - CALL_RECORDING_FLUSH_LAG_BYTES);
    await this.flushTo(targetBytes);
  }

  private async flushTo(targetBytes: number): Promise<void> {
    if (!this.liveMode) return;
    this.flushPromise = this.flushPromise.then(async () => {
      const alignedTarget = targetBytes - (targetBytes % 2);
      if (alignedTarget <= this.flushedBytes) return;

      const [{ filePath: callerPath }, { filePath: agentPath }] = await Promise.all([
        this.caller.snapshot(),
        this.agent.snapshot(),
      ]);

      let callerHandle: FileHandle | null = null;
      let agentHandle: FileHandle | null = null;
      try {
        callerHandle = callerPath ? await open(callerPath, "r") : null;
        agentHandle = agentPath ? await open(agentPath, "r") : null;

        for (let offset = this.flushedBytes; offset < alignedTarget; offset += CALL_RECORDING_MIX_CHUNK_BYTES) {
          const bytesToRead = Math.min(CALL_RECORDING_MIX_CHUNK_BYTES, alignedTarget - offset);
          if (bytesToRead <= 0) continue;
          const callerChunk = await readChunk(callerHandle, offset, bytesToRead);
          const agentChunk = await readChunk(agentHandle, offset, bytesToRead);
          this.liveQueue.push(mixPcmChunks(callerChunk, agentChunk));
          this.flushedBytes = offset + bytesToRead;
        }
      } finally {
        await Promise.allSettled([callerHandle?.close(), agentHandle?.close()]);
      }
    });

    await this.flushPromise;
  }
}

class RecordingSideWriter {
  private static readonly ZERO_CHUNK = Buffer.alloc(64 * 1024);
  private filePath: string | null = null;
  private fileHandle: FileHandle | null = null;
  private pending = Promise.resolve();
  private writtenSamples = 0;

  constructor(private readonly role: CallSide) {}

  appendSegment(
    pcm: Buffer,
    startMs: number,
    getTempDir: () => Promise<string>,
  ): Promise<void> {
    const startSample = Math.max(
      0,
      Math.round((startMs / 1000) * CALL_RECORDING_SAMPLE_RATE),
    );

    this.pending = this.pending.then(async () => {
      const dir = await getTempDir();
      const fileHandle = await this.ensureFileHandle(dir);

      let chunk = pcm;
      if (startSample < this.writtenSamples) {
        const overlapBytes = Math.min(chunk.length, (this.writtenSamples - startSample) * 2);
        chunk = chunk.subarray(overlapBytes);
      } else if (startSample > this.writtenSamples) {
        await this.writeZeros(fileHandle, (startSample - this.writtenSamples) * 2);
        this.writtenSamples = startSample;
      }

      if (chunk.length === 0) return;

      await writeAll(fileHandle, chunk);
      this.writtenSamples += chunk.length / 2;
    });

    return this.pending;
  }

  async finish(): Promise<{ filePath: string | null; totalBytes: number }> {
    await this.pending;
    await this.closeHandle();
    return {
      filePath: this.filePath,
      totalBytes: this.writtenSamples * 2,
    };
  }

  async snapshot(): Promise<{ filePath: string | null; totalBytes: number }> {
    await this.pending;
    return {
      filePath: this.filePath,
      totalBytes: this.writtenSamples * 2,
    };
  }

  async discard(): Promise<void> {
    await Promise.allSettled([this.pending]);
    await this.closeHandle();
  }

  private async ensureFileHandle(dir: string): Promise<FileHandle> {
    if (this.fileHandle) return this.fileHandle;
    if (!this.filePath) {
      this.filePath = join(dir, `${this.role}-${randomUUID()}.pcm`);
    }
    this.fileHandle = await open(this.filePath, "w");
    return this.fileHandle;
  }

  private async closeHandle(): Promise<void> {
    if (!this.fileHandle) return;
    const handle = this.fileHandle;
    this.fileHandle = null;
    await handle.close();
  }

  private async writeZeros(fileHandle: FileHandle, totalBytes: number): Promise<void> {
    let remaining = totalBytes;
    while (remaining > 0) {
      const chunkSize = Math.min(remaining, RecordingSideWriter.ZERO_CHUNK.length);
      await writeAll(fileHandle, RecordingSideWriter.ZERO_CHUNK.subarray(0, chunkSize));
      remaining -= chunkSize;
    }
  }
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

async function writeAll(fileHandle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fileHandle.write(buffer, offset, buffer.length - offset);
    offset += bytesWritten;
  }
}

async function readChunk(
  fileHandle: FileHandle | null,
  position: number,
  byteLength: number,
): Promise<Buffer> {
  const chunk = Buffer.alloc(byteLength);
  if (!fileHandle) return chunk;

  let offset = 0;
  while (offset < byteLength) {
    const { bytesRead } = await fileHandle.read(chunk, offset, byteLength - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return chunk;
}

function mixPcmChunks(callerChunk: Buffer, agentChunk: Buffer): Buffer {
  const mixed = Buffer.alloc(callerChunk.length);
  for (let i = 0; i < callerChunk.length; i += 2) {
    const callerSample = callerChunk.readInt16LE(i);
    const agentSample = agentChunk.readInt16LE(i);
    const sum = callerSample + agentSample;
    mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i);
  }
  return mixed;
}

class AsyncBufferQueue implements AsyncIterable<Buffer> {
  private chunks: Buffer[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<Buffer>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private error: Error | null = null;
  private closed = false;

  push(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
  }

  fail(err: Error): void {
    if (this.closed) return;
    this.error = err;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<Buffer>> {
    if (this.error) {
      const err = this.error;
      this.error = null;
      throw err;
    }

    const chunk = this.chunks.shift();
    if (chunk) {
      return { value: chunk, done: false };
    }
    if (this.closed) {
      return { value: undefined, done: true };
    }
    return new Promise<IteratorResult<Buffer>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: () => this.next(),
    };
  }
}
