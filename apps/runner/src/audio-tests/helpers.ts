/**
 * Shared helpers for audio test executors.
 */

import type { AudioChannel } from "@voiceci/adapters";
import { VoiceActivityDetector, type VADState } from "@voiceci/voice";

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
    audio: Buffer.concat(chunks),
    timedOut,
    stats: { speechSegments, maxInternalSilenceMs, totalSpeechMs, firstChunkAt },
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

  return Buffer.concat(chunks);
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
