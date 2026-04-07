/**
 * Batch VAD analysis using TEN VAD (WASM).
 *
 * Unlike VoiceActivityDetector (streaming, uses Date.now() for silence timing),
 * BatchVAD processes a complete PCM buffer and returns speech segments with
 * audio-timeline timestamps derived from frame position (not wall clock).
 * Runs per-turn during the conversation loop after each agent audio buffer
 * is collected. Used for post-conversation metrics: talk ratio, monologue
 * detection, silence gap analysis.
 *
 * TEN VAD expects 16kHz mono PCM int16, 256-sample frames (16ms each).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resample } from "./format.js";

export interface SpeechSegment {
  startMs: number;
  endMs: number;
  meanProbability: number;
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
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
}

const HOP_SIZE = 256;
const VAD_THRESHOLD = 0.5;
const SAMPLE_RATE_16K = 16000;
const FRAME_MS = (HOP_SIZE / SAMPLE_RATE_16K) * 1000; // 16ms per frame

// Hysteresis: prevent flicker from brief noise/silence
const SPEECH_ONSET_FRAMES = 3;   // 48ms of consecutive voice to start a segment
const SPEECH_OFFSET_FRAMES = 15; // 240ms of consecutive silence to end a segment

export class BatchVAD {
  private module: TenVADModule | null = null;
  private handle = 0;
  private audioPtr = 0;
  private probPtr = 0;
  private flagPtr = 0;

  async init(): Promise<void> {
    const wasmPath = join(__dirname, "ten-vad", "ten_vad.wasm");
    const wasmBuffer = readFileSync(wasmPath);
    const wasmBinary = wasmBuffer.buffer.slice(
      wasmBuffer.byteOffset,
      wasmBuffer.byteOffset + wasmBuffer.byteLength
    );

    const { default: createVADModule } = (await import(
      /* webpackIgnore: true */ "./ten-vad/ten_vad.mjs"
    )) as { default: unknown };
    this.module = await (
      createVADModule as (opts: { wasmBinary: ArrayBuffer }) => Promise<TenVADModule>
    )({ wasmBinary });

    const handlePtr = this.module._malloc(4);
    const result = this.module._ten_vad_create(handlePtr, HOP_SIZE, VAD_THRESHOLD);
    if (result !== 0) {
      this.module._free(handlePtr);
      throw new Error("Failed to create TEN VAD instance for batch analysis");
    }
    this.handle = this.module.HEAP32[handlePtr >> 2]!;
    this.module._free(handlePtr);

    this.audioPtr = this.module._malloc(HOP_SIZE * 2);
    this.probPtr = this.module._malloc(4);
    this.flagPtr = this.module._malloc(4);
  }

  /**
   * Analyze a complete 24kHz mono PCM int16 buffer and return speech segments.
   * Uses audio-timeline timestamps (no Date.now() dependency).
   */
  analyze(pcm24k: Buffer): SpeechSegment[] {
    if (!this.module) throw new Error("BatchVAD not initialized — call init() first");
    if (pcm24k.length === 0) return [];

    const pcm16k = resample(pcm24k, 24000, 16000);
    const samples = new Int16Array(pcm16k.buffer, pcm16k.byteOffset, pcm16k.length / 2);
    const totalFrames = Math.floor(samples.length / HOP_SIZE);

    // Pass 1: get per-frame voice flags
    const flags: boolean[] = new Array(totalFrames);
    const probs: number[] = new Array(totalFrames);

    for (let i = 0; i < totalFrames; i++) {
      const offset = i * HOP_SIZE;
      this.module.HEAP16.set(
        samples.subarray(offset, offset + HOP_SIZE),
        this.audioPtr / 2
      );
      this.module.HEAPF32[this.probPtr >> 2] = 0;
      this.module.HEAP32[this.flagPtr >> 2] = 0;

      this.module._ten_vad_process(
        this.handle,
        this.audioPtr,
        HOP_SIZE,
        this.probPtr,
        this.flagPtr
      );

      flags[i] = this.module.HEAP32[this.flagPtr >> 2] === 1;
      probs[i] = this.module.HEAPF32[this.probPtr >> 2]!;
    }

    // Pass 2: hysteresis smoothing → speech segments
    return extractSegments(flags, probs, totalFrames);
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

/**
 * Extract speech segments from per-frame voice flags with hysteresis.
 * Speech starts after SPEECH_ONSET_FRAMES consecutive voice frames.
 * Speech ends after SPEECH_OFFSET_FRAMES consecutive silence frames.
 */
function extractSegments(
  flags: boolean[],
  probs: number[],
  totalFrames: number
): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  let inSpeech = false;
  let consecutiveVoice = 0;
  let consecutiveSilence = 0;
  let segmentStartFrame = 0;
  let probSum = 0;
  let probCount = 0;

  for (let i = 0; i < totalFrames; i++) {
    if (flags[i]) {
      consecutiveVoice++;
      consecutiveSilence = 0;

      if (!inSpeech && consecutiveVoice >= SPEECH_ONSET_FRAMES) {
        inSpeech = true;
        segmentStartFrame = i - SPEECH_ONSET_FRAMES + 1;
        probSum = 0;
        probCount = 0;
        // Include onset frames in probability calculation
        for (let j = segmentStartFrame; j <= i; j++) {
          probSum += probs[j]!;
          probCount++;
        }
      } else if (inSpeech) {
        probSum += probs[i]!;
        probCount++;
      }
    } else {
      consecutiveSilence++;
      consecutiveVoice = 0;

      if (inSpeech) {
        // Don't include silence frames in meanProbability — only count voiced frames
        if (consecutiveSilence >= SPEECH_OFFSET_FRAMES) {
          // End segment at the frame before the silence run started
          const segmentEndFrame = i - SPEECH_OFFSET_FRAMES;
          segments.push({
            startMs: Math.round(segmentStartFrame * FRAME_MS),
            endMs: Math.round((segmentEndFrame + 1) * FRAME_MS),
            meanProbability: probCount > 0 ? probSum / probCount : 0,
          });
          inSpeech = false;
          probSum = 0;
          probCount = 0;
        }
      }
    }
  }

  // Close any open segment at end of audio
  if (inSpeech) {
    segments.push({
      startMs: Math.round(segmentStartFrame * FRAME_MS),
      endMs: Math.round(totalFrames * FRAME_MS),
      meanProbability: probCount > 0 ? probSum / probCount : 0,
    });
  }

  return segments;
}
