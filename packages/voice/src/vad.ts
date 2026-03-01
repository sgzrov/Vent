/**
 * Voice Activity Detection using TEN VAD (WASM).
 * Wraps the vendored TEN VAD WebAssembly module for Node.js usage.
 *
 * TEN VAD expects 16kHz mono PCM int16, 256-sample frames (16ms).
 * This wrapper accepts 24kHz PCM and resamples internally.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resample } from "./format.js";

export type VADState = "speech" | "silence" | "end_of_turn";

export interface VoiceActivityDetectorConfig {
  /** Silence duration (ms) after speech before returning "end_of_turn". Default: 1500 */
  silenceThresholdMs?: number;
  /** VAD hop size in samples. Must match TEN VAD expectations. Default: 256 */
  hopSize?: number;
  /** VAD detection threshold [0.0, 1.0]. Default: 0.5 */
  vadThreshold?: number;
}

interface TenVADModule {
  _ten_vad_create(handlePtr: number, hopSize: number, threshold: number): number;
  _ten_vad_process(
    handle: number,
    audioDataPtr: number,
    audioDataLength: number,
    outProbabilityPtr: number,
    outFlagPtr: number
  ): number;
  _ten_vad_destroy(handlePtr: number): number;
  _ten_vad_get_version(): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  UTF8ToString(ptr: number): string;
}

export class VoiceActivityDetector {
  private module: TenVADModule | null = null;
  private handle = 0;
  private readonly hopSize: number;
  private readonly vadThreshold: number;
  private readonly silenceThresholdMs: number;

  private silenceStartMs: number | null = null;
  private hasSpeech = false;

  // Pre-allocated WASM memory pointers
  private audioPtr = 0;
  private probPtr = 0;
  private flagPtr = 0;

  // Accumulation buffer for partial frames
  private sampleBuffer: Int16Array;
  private sampleBufferOffset = 0;

  constructor(config: VoiceActivityDetectorConfig = {}) {
    this.hopSize = config.hopSize ?? 256;
    this.vadThreshold = config.vadThreshold ?? 0.5;
    this.silenceThresholdMs = config.silenceThresholdMs ?? 1500;
    this.sampleBuffer = new Int16Array(this.hopSize);
  }

  async init(): Promise<void> {
    // Load WASM binary from vendored file (__dirname available in CJS output)
    const wasmPath = join(__dirname, "ten-vad", "ten_vad.wasm");
    const wasmBuffer = readFileSync(wasmPath);

    // Convert Node Buffer to ArrayBuffer for Emscripten
    const wasmBinary = wasmBuffer.buffer.slice(
      wasmBuffer.byteOffset,
      wasmBuffer.byteOffset + wasmBuffer.byteLength
    );

    // Dynamic import of the Emscripten-generated loader (.mjs for ESM compat)
    const { default: createVADModule } = await import(
      /* webpackIgnore: true */ "./ten-vad/ten_vad.mjs"
    ) as { default: unknown };
    this.module = await (createVADModule as (opts: { wasmBinary: ArrayBuffer }) => Promise<TenVADModule>)({
      wasmBinary,
    });

    // Create VAD handle (pointer-to-pointer pattern)
    const handlePtr = this.module._malloc(4);
    const result = this.module._ten_vad_create(handlePtr, this.hopSize, this.vadThreshold);
    if (result !== 0) {
      this.module._free(handlePtr);
      throw new Error("Failed to create TEN VAD instance");
    }
    this.handle = this.module.HEAP32[handlePtr >> 2]!;
    this.module._free(handlePtr);

    // Pre-allocate WASM memory for processing
    this.audioPtr = this.module._malloc(this.hopSize * 2); // int16 = 2 bytes each
    this.probPtr = this.module._malloc(4);  // float32
    this.flagPtr = this.module._malloc(4);  // int32
  }

  /**
   * Process 24kHz mono PCM int16 audio.
   * Resamples to 16kHz internally, accumulates into hopSize frames,
   * and returns the VAD state after processing all input.
   */
  process(pcm24k: Buffer): VADState {
    if (!this.module) throw new Error("VAD not initialized — call init() first");

    // Resample 24kHz → 16kHz for TEN VAD
    const pcm16k = resample(pcm24k, 24000, 16000);

    const samples = new Int16Array(
      pcm16k.buffer,
      pcm16k.byteOffset,
      pcm16k.length / 2
    );

    let state = this.currentState();
    let offset = 0;

    while (offset < samples.length) {
      const remaining = this.hopSize - this.sampleBufferOffset;
      const toCopy = Math.min(remaining, samples.length - offset);
      this.sampleBuffer.set(
        samples.subarray(offset, offset + toCopy),
        this.sampleBufferOffset
      );
      this.sampleBufferOffset += toCopy;
      offset += toCopy;

      if (this.sampleBufferOffset === this.hopSize) {
        state = this.processFrame(this.sampleBuffer);
        this.sampleBufferOffset = 0;
      }
    }

    return state;
  }

  private currentState(): VADState {
    if (!this.hasSpeech) return "silence";
    if (this.silenceStartMs !== null) {
      if (Date.now() - this.silenceStartMs >= this.silenceThresholdMs) {
        return "end_of_turn";
      }
    }
    return "silence";
  }

  private processFrame(samples: Int16Array): VADState {
    const mod = this.module!;

    // Copy int16 samples into WASM heap
    mod.HEAP16.set(samples, this.audioPtr / 2);

    // Reset output pointers
    mod.HEAPF32[this.probPtr >> 2] = 0;
    mod.HEAP32[this.flagPtr >> 2] = 0;

    const result = mod._ten_vad_process(
      this.handle,
      this.audioPtr,
      this.hopSize,
      this.probPtr,
      this.flagPtr
    );

    if (result !== 0) {
      throw new Error("TEN VAD process failed");
    }

    const isVoice = mod.HEAP32[this.flagPtr >> 2] === 1;
    const now = Date.now();

    if (isVoice) {
      this.hasSpeech = true;
      this.silenceStartMs = null;
      return "speech";
    }

    // No voice detected
    if (!this.hasSpeech) {
      return "silence";
    }

    // Had speech before, now silence — track duration
    if (this.silenceStartMs === null) {
      this.silenceStartMs = now;
    }

    if (now - this.silenceStartMs >= this.silenceThresholdMs) {
      return "end_of_turn";
    }

    return "silence";
  }

  getVersion(): string {
    if (!this.module) throw new Error("VAD not initialized");
    const ptr = this.module._ten_vad_get_version();
    return this.module.UTF8ToString(ptr);
  }

  reset(): void {
    this.hasSpeech = false;
    this.silenceStartMs = null;
    this.sampleBufferOffset = 0;
  }

  destroy(): void {
    if (!this.module) return;

    if (this.audioPtr) this.module._free(this.audioPtr);
    if (this.probPtr) this.module._free(this.probPtr);
    if (this.flagPtr) this.module._free(this.flagPtr);

    if (this.handle) {
      const handlePtr = this.module._malloc(4);
      this.module.HEAP32[handlePtr >> 2] = this.handle;
      this.module._ten_vad_destroy(handlePtr);
      this.module._free(handlePtr);
    }

    this.module = null;
    this.handle = 0;
    this.audioPtr = 0;
    this.probPtr = 0;
    this.flagPtr = 0;
  }
}
