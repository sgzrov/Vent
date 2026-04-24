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
  /**
   * Minimum RMS energy (int16 scale) for a frame to be considered for speech.
   * Frames below this are treated as silence without consulting the neural
   * network. Filters WebRTC comfort noise (~30-200 RMS) that otherwise
   * triggers false positives and prevents end-of-turn detection.
   * Default: 100 — chosen to sit just above typical comfort-noise floor so
   * quieter platform TTS (Retell/LiveKit, meanAbs often 200-300) reaches the
   * neural model. Isolated comfort-noise false positives that slip past the
   * gate are filtered by `minSpeechOnsetFrames` hysteresis below.
   */
  energyFloorRms?: number;
  /**
   * Minimum consecutive voice-classified frames required to flip from the
   * "no speech yet" state to "speech". Once in speech state, a single voice
   * frame resets the silence counter — this hysteresis only applies to the
   * initial onset. Filters isolated neural-VAD false positives on comfort
   * noise (observed ~17% single-frame rate) without losing sensitivity to
   * real speech onsets (which last many consecutive frames).
   * Default: 2 (≈32ms at 16kHz / hopSize 256).
   */
  minSpeechOnsetFrames?: number;
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
  private readonly energyFloorRms: number;
  private readonly minSpeechOnsetFrames: number;
  /** Silence duration (ms) after speech before returning "end_of_turn". Mutable for adaptive thresholds. */
  silenceThresholdMs: number;

  private hasSpeech = false;
  /** Count of consecutive "voice" frames while hasSpeech is still false.
   *  Reset on any non-voice frame. Used to gate speech-onset transitions
   *  so a single false-positive voice frame can't flip the state. */
  private pendingSpeechFrames = 0;

  // Audio-timeline silence tracking (frame count, not wall-clock).
  // Each frame = hopSize samples at 16kHz = hopSize/16 ms.
  // Using frame count avoids the wall-clock vs audio-clock mismatch that
  // occurs when the event loop processes audio frames in bursts under CPU
  // contention — Date.now() barely advances between burst-processed frames,
  // so real 800ms silences appear as <10ms of wall-clock time.
  private silenceFrames = 0;
  private readonly frameDurationMs: number;

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
    this.energyFloorRms = config.energyFloorRms ?? 100;
    this.minSpeechOnsetFrames = config.minSpeechOnsetFrames ?? 2;
    this.sampleBuffer = new Int16Array(this.hopSize);
    // 256 samples at 16kHz = 16ms per frame
    this.frameDurationMs = (this.hopSize / 16000) * 1000;
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
    if (this.silenceFrames > 0) {
      if (this.silenceFrames * this.frameDurationMs >= this.silenceThresholdMs) {
        return "end_of_turn";
      }
    }
    return "silence";
  }

  private processFrame(samples: Int16Array): VADState {
    const mod = this.module!;

    // Energy gate: skip VAD neural network for frames below the noise floor.
    // WebRTC comfort noise (generated when the remote party is silent) has
    // RMS ~30-200 on int16 scale. Without this gate, the neural network
    // sporadically classifies comfort noise as speech (~17% of frames),
    // preventing the silence counter from ever reaching the end-of-turn
    // threshold.
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i]! * samples[i]!;
    }
    const rms = Math.sqrt(sumSq / samples.length);

    if (rms < this.energyFloorRms) {
      // Below noise floor — treat as silence without consulting the model
      this.pendingSpeechFrames = 0;
      if (!this.hasSpeech) return "silence";
      this.silenceFrames++;
      if (this.silenceFrames * this.frameDurationMs >= this.silenceThresholdMs) {
        return "end_of_turn";
      }
      return "silence";
    }

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

    if (isVoice) {
      this.silenceFrames = 0;
      if (this.hasSpeech) {
        // Already in speech state — a single voice frame is enough to stay there.
        return "speech";
      }
      // First-onset hysteresis: require minSpeechOnsetFrames consecutive voice
      // frames before flipping to the "speech" state. Filters isolated neural
      // false positives that the energy gate let through.
      this.pendingSpeechFrames++;
      if (this.pendingSpeechFrames >= this.minSpeechOnsetFrames) {
        this.hasSpeech = true;
        return "speech";
      }
      return "silence";
    }

    // Not voice — reset pending onset counter and handle silence
    this.pendingSpeechFrames = 0;
    if (!this.hasSpeech) {
      return "silence";
    }

    // Had speech before, now silence — count frames on audio timeline
    this.silenceFrames++;

    if (this.silenceFrames * this.frameDurationMs >= this.silenceThresholdMs) {
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
    this.silenceFrames = 0;
    this.pendingSpeechFrames = 0;
    this.sampleBufferOffset = 0;

    // Reset WASM model state by destroying and recreating the VAD handle.
    // TEN VAD's RNN/GRU accumulates hidden state across frames. After
    // processing thousands of silence frames between conversation turns,
    // the hidden state drifts toward silence classification — causing the
    // model to miss real speech on later turns. The WASM module stays
    // loaded (no recompilation), only the model state is reset.
    if (this.module && this.handle) {
      const handlePtr = this.module._malloc(4);
      this.module.HEAP32[handlePtr >> 2] = this.handle;
      this.module._ten_vad_destroy(handlePtr);

      const result = this.module._ten_vad_create(handlePtr, this.hopSize, this.vadThreshold);
      if (result !== 0) {
        this.module._free(handlePtr);
        throw new Error("Failed to recreate TEN VAD instance on reset");
      }
      this.handle = this.module.HEAP32[handlePtr >> 2]!;
      this.module._free(handlePtr);
    }
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
