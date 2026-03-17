/**
 * Shared helpers for audio test executors.
 */

import type { AudioChannel } from "@vent/adapters";
import { VoiceActivityDetector, type VADState, transcribe as sttTranscribe, concatPcm } from "@vent/voice";
import { generateSilence } from "./signals.js";

/**
 * Stats about audio collection — used by adaptive threshold to tune silence detection.
 */
export interface CollectionStats {
  /** Number of distinct speech segments (speech→silence→speech = 2 segments) */
  speechSegments: number;
  /** Longest mid-response silence in ms (silence between speech segments, NOT the final silence) */
  maxInternalSilenceMs: number;
  /** Total time spent in speech state (ms) */
  totalSpeechMs: number;
  /** Timestamp (Date.now()) when the first audio chunk was received, or null if none */
  firstChunkAt: number | null;
  /** Timestamp (Date.now()) when VAD first detected speech, or null if no speech detected */
  speechOnsetAt: number | null;
}

/**
 * Collect audio from the channel until VAD detects end-of-turn or timeout.
 * Returns the concatenated PCM buffer of all received audio plus collection stats
 * for adaptive threshold tuning.
 */
export async function collectUntilEndOfTurn(
  channel: AudioChannel,
  opts: {
    timeoutMs?: number;
    silenceThresholdMs?: number;
    /** Pre-initialized VAD instance — reused across turns to avoid WASM reload. */
    vad?: VoiceActivityDetector;
  } = {}
): Promise<{ audio: Buffer; timedOut: boolean; stats: CollectionStats }> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const silenceThresholdMs = opts.silenceThresholdMs ?? 800;

  const ownsVAD = !opts.vad;
  const vad = opts.vad ?? new VoiceActivityDetector({ silenceThresholdMs });
  if (ownsVAD) await vad.init();
  else vad.reset();

  const chunks: Buffer[] = [];
  let timedOut = false;

  // State transition tracking for adaptive thresholds
  let prevState: VADState = "silence";
  let speechSegments = 0;
  let maxInternalSilenceMs = 0;
  let totalSpeechMs = 0;
  let silenceStartedAt: number | null = null;
  let speechStartedAt: number | null = null;
  let firstChunkAt: number | null = null;
  let speechOnsetAt: number | null = null;

  try {
    await new Promise<void>((resolve) => {
      const onAudio = (chunk: Buffer) => {
        chunks.push(chunk);
        const state = vad.process(chunk);
        const now = Date.now();
        if (firstChunkAt === null) firstChunkAt = now;

        // Track speech → silence transition
        if (state === "silence" && prevState === "speech") {
          silenceStartedAt = now;
          if (speechStartedAt !== null) {
            totalSpeechMs += now - speechStartedAt;
            speechStartedAt = null;
          }
        }

        // Track silence → speech transition (mid-response pause resolved)
        if (state === "speech" && prevState !== "speech") {
          speechSegments++;
          if (speechOnsetAt === null) speechOnsetAt = now;
          speechStartedAt = now;
          if (silenceStartedAt !== null) {
            const silenceDurationMs = now - silenceStartedAt;
            maxInternalSilenceMs = Math.max(maxInternalSilenceMs, silenceDurationMs);
            silenceStartedAt = null;
          }
        }

        prevState = state;

        if (state === "end_of_turn") {
          clearTimeout(timeout);
          channel.off("audio", onAudio);
          channel.off("error", onError);
          resolve();
        }
      };

      const onError = (err: Error) => {
        timedOut = true;
        clearTimeout(timeout);
        channel.off("audio", onAudio);
        channel.off("error", onError);
        resolve();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        channel.off("audio", onAudio);
        channel.off("error", onError);
        resolve();
      }, timeoutMs);

      channel.on("audio", onAudio);
      channel.on("error", onError);
    });
  } finally {
    // Account for speech that was still ongoing at end
    if (speechStartedAt !== null) {
      totalSpeechMs += Date.now() - speechStartedAt;
    }
    if (ownsVAD) vad.destroy();
  }

  return {
    audio: concatPcm(chunks),
    timedOut,
    stats: { speechSegments, maxInternalSilenceMs, totalSpeechMs, firstChunkAt, speechOnsetAt },
  };
}

/**
 * Collect audio from the channel for a fixed duration.
 */
export async function collectForDuration(
  channel: AudioChannel,
  durationMs: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve) => {
    const onAudio = (chunk: Buffer) => {
      chunks.push(chunk);
    };

    const onError = () => {
      clearTimeout(timeout);
      channel.off("audio", onAudio);
      channel.off("error", onError);
      resolve();
    };

    const timeout = setTimeout(() => {
      channel.off("audio", onAudio);
      channel.off("error", onError);
      resolve();
    }, durationMs);

    channel.on("audio", onAudio);
    channel.on("error", onError);
  });

  return concatPcm(chunks);
}

/**
 * Wait until VAD detects the first speech in the channel audio,
 * or timeout. Returns the timestamp when speech was first detected.
 */
export async function waitForSpeech(
  channel: AudioChannel,
  timeoutMs = 10000
): Promise<{ detectedAt: number; timedOut: boolean }> {
  const vad = new VoiceActivityDetector({ silenceThresholdMs: 500 });
  await vad.init();

  let timedOut = false;
  let detectedAt = 0;

  try {
    await new Promise<void>((resolve) => {
      const onAudio = (chunk: Buffer) => {
        const state = vad.process(chunk);
        if (state === "speech") {
          detectedAt = Date.now();
          clearTimeout(timeout);
          channel.off("audio", onAudio);
          channel.off("error", onError);
          resolve();
        }
      };

      const onError = () => {
        timedOut = true;
        clearTimeout(timeout);
        channel.off("audio", onAudio);
        channel.off("error", onError);
        resolve();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        channel.off("audio", onAudio);
        channel.off("error", onError);
        resolve();
      }, timeoutMs);

      channel.on("audio", onAudio);
      channel.on("error", onError);
    });
  } finally {
    vad.destroy();
  }

  return { detectedAt, timedOut };
}

/**
 * Stream silence to the channel in 20ms chunks.
 * Used by silence audio actions and echo probes.
 */
export async function streamSilence(
  channel: AudioChannel,
  durationMs: number,
): Promise<void> {
  const chunkMs = 20;
  const chunk = generateSilence(chunkMs);
  const chunks = Math.ceil(durationMs / chunkMs);

  for (let i = 0; i < chunks; i++) {
    channel.sendAudio(chunk);
    // Pace at real-time to avoid buffer flooding
    await new Promise((r) => setTimeout(r, chunkMs));
  }
}

/**
 * Transcribe a PCM audio buffer using Deepgram batch STT.
 * Returns the transcribed text, or empty string if audio is too short.
 */
export async function transcribeAudio(audio: Buffer): Promise<string> {
  if (audio.length < 4800) return ""; // < 100ms of audio
  const { text } = await sttTranscribe(audio);
  return text;
}

/**
 * Jaccard token overlap similarity (0-1).
 * Used to compare clean vs degraded responses.
 */
export function textSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Simple linear regression slope for drift detection.
 * Returns ms-per-turn drift rate.
 */
export function linearRegressionSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
