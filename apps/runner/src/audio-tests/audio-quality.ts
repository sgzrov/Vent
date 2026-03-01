/**
 * Audio Quality test — analyzes the agent's output audio for signal-level issues.
 *
 * Checks:
 * - Clipping (samples near ±32767)
 * - RMS energy consistency (sudden drops/spikes)
 * - Clean start/end (no pops or clicks)
 * - Minimum duration (not truncated)
 * - Estimated SNR
 */

import type { AudioChannel } from "@voiceci/adapters";
import type { AudioTestResult, AudioTestThresholds } from "@voiceci/shared";
import { synthesize } from "@voiceci/voice";
import { collectUntilEndOfTurn } from "./helpers.js";

const DEFAULT_MAX_CLIPPING_RATIO = 0.005;
const DEFAULT_MIN_DURATION_MS = 1000;
const DEFAULT_MIN_ENERGY_CONSISTENCY = 0.4;

const SAMPLE_RATE = 24000;
const CLIPPING_THRESHOLD = 32700;
const WINDOW_MS = 100;
const WINDOW_SAMPLES = Math.floor((SAMPLE_RATE * WINDOW_MS) / 1000);
const SILENCE_RMS_THRESHOLD = 100;
const CLICK_THRESHOLD = 20000;
const DROP_FACTOR = 0.05; // 95% drop = actual dropout, not natural inter-word pauses
const SPIKE_FACTOR = 3.0;
const DROP_CONSECUTIVE_MIN = 2; // Require 2+ consecutive low windows to count as a drop

const PROMPT = "Please describe the process of making a cup of coffee in detail.";

export async function runAudioQualityTest(
  channel: AudioChannel,
  thresholds?: AudioTestThresholds,
): Promise<AudioTestResult> {
  const MAX_CLIPPING = thresholds?.audio_quality?.max_clipping_ratio ?? DEFAULT_MAX_CLIPPING_RATIO;
  const MIN_DURATION = thresholds?.audio_quality?.min_duration_ms ?? DEFAULT_MIN_DURATION_MS;
  const MIN_CONSISTENCY = thresholds?.audio_quality?.min_energy_consistency ?? DEFAULT_MIN_ENERGY_CONSISTENCY;
  const startTime = performance.now();

  // Elicit a response
  const promptAudio = await synthesize(PROMPT);
  channel.sendAudio(promptAudio);

  const { audio: agentAudio } = await collectUntilEndOfTurn(channel, {
    timeoutMs: 20000,
    silenceThresholdMs: 2000,
  });

  if (agentAudio.length === 0) {
    return {
      test_name: "audio_quality",
      status: "fail",
      metrics: { response_received: false },
      duration_ms: Math.round(performance.now() - startTime),
      error: "Agent did not produce any audio",
    };
  }

  const totalSamples = agentAudio.length / 2;
  const audioDurationMs = Math.round((totalSamples / SAMPLE_RATE) * 1000);

  // 1. Clipping detection
  let clippedSamples = 0;
  for (let i = 0; i < totalSamples; i++) {
    if (Math.abs(agentAudio.readInt16LE(i * 2)) >= CLIPPING_THRESHOLD) {
      clippedSamples++;
    }
  }
  const clippingRatio = clippedSamples / totalSamples;

  // 2. RMS energy consistency (windowed analysis)
  const windowCount = Math.floor(totalSamples / WINDOW_SAMPLES);
  const windowRms: number[] = [];

  for (let w = 0; w < windowCount; w++) {
    let sum = 0;
    const offset = w * WINDOW_SAMPLES;
    for (let i = 0; i < WINDOW_SAMPLES; i++) {
      const s = agentAudio.readInt16LE((offset + i) * 2);
      sum += s * s;
    }
    windowRms.push(Math.sqrt(sum / WINDOW_SAMPLES));
  }

  const speechWindows = windowRms.filter((r) => r >= SILENCE_RMS_THRESHOLD);
  const silenceWindows = windowRms.filter((r) => r < SILENCE_RMS_THRESHOLD);

  let energyConsistency = 1;
  let suddenDrops = 0;
  let suddenSpikes = 0;
  let meanSpeechRms = 0;

  if (speechWindows.length >= 3) {
    meanSpeechRms = speechWindows.reduce((a, b) => a + b, 0) / speechWindows.length;
    const variance = speechWindows.reduce((a, r) => a + (r - meanSpeechRms) ** 2, 0) / speechWindows.length;
    const stddev = Math.sqrt(variance);
    energyConsistency = meanSpeechRms > 0 ? Math.max(0, 1 - stddev / meanSpeechRms) : 0;

    // Detect sudden drops/spikes within speech region (debounced)
    let consecutiveDrops = 0;
    for (let i = 1; i < windowRms.length - 1; i++) {
      const prev = windowRms[i - 1]!;
      const curr = windowRms[i]!;
      const next = windowRms[i + 1]!;

      const isSpeechRegion = prev >= SILENCE_RMS_THRESHOLD && next >= SILENCE_RMS_THRESHOLD;
      if (isSpeechRegion) {
        if (curr < meanSpeechRms * DROP_FACTOR) {
          consecutiveDrops++;
          if (consecutiveDrops >= DROP_CONSECUTIVE_MIN) suddenDrops++;
        } else {
          consecutiveDrops = 0;
        }
        if (curr > meanSpeechRms * SPIKE_FACTOR) suddenSpikes++;
      } else {
        consecutiveDrops = 0;
      }
    }
  }

  // 3. Clean start/end (check first/last 10ms for clicks)
  const edgeSamples = Math.floor((SAMPLE_RATE * 10) / 1000); // 240 samples
  let cleanStart = true;
  let cleanEnd = true;

  for (let i = 0; i < Math.min(edgeSamples, totalSamples); i++) {
    if (Math.abs(agentAudio.readInt16LE(i * 2)) > CLICK_THRESHOLD) {
      cleanStart = false;
      break;
    }
  }

  for (let i = totalSamples - 1; i >= Math.max(0, totalSamples - edgeSamples); i--) {
    if (Math.abs(agentAudio.readInt16LE(i * 2)) > CLICK_THRESHOLD) {
      cleanEnd = false;
      break;
    }
  }

  // 4. Duration check
  const durationOk = audioDurationMs >= MIN_DURATION;

  // 5. SNR estimate
  const noiseFloorRms =
    silenceWindows.length > 0
      ? silenceWindows.reduce((a, b) => a + b, 0) / silenceWindows.length
      : 0;
  const estimatedSnrDb =
    noiseFloorRms > 0 && meanSpeechRms > 0
      ? Math.round(20 * Math.log10(meanSpeechRms / noiseFloorRms) * 10) / 10
      : -1;

  // Pass/fail
  const clippingOk = clippingRatio <= MAX_CLIPPING;
  const consistencyOk = energyConsistency >= MIN_CONSISTENCY || speechWindows.length < 3;
  const noArtifacts = suddenDrops === 0 && suddenSpikes === 0;

  const passed = clippingOk && consistencyOk && noArtifacts && cleanStart && cleanEnd && durationOk;
  const durationMs = Math.round(performance.now() - startTime);

  const errors: string[] = [];
  if (!clippingOk) errors.push(`clipping ratio ${clippingRatio.toFixed(4)} > ${MAX_CLIPPING}`);
  if (!consistencyOk) errors.push(`energy consistency ${energyConsistency.toFixed(2)} < ${MIN_CONSISTENCY}`);
  if (suddenDrops > 0) errors.push(`${suddenDrops} sudden volume drop(s)`);
  if (suddenSpikes > 0) errors.push(`${suddenSpikes} sudden volume spike(s)`);
  if (!cleanStart) errors.push("click/pop detected at audio start");
  if (!cleanEnd) errors.push("click/pop detected at audio end");
  if (!durationOk) errors.push(`audio duration ${audioDurationMs}ms < ${MIN_DURATION}ms`);

  return {
    test_name: "audio_quality",
    status: passed ? "pass" : "fail",
    metrics: {
      duration_ms_audio: audioDurationMs,
      total_samples: totalSamples,
      clipping_ratio: Math.round(clippingRatio * 10000) / 10000,
      clipped_samples: clippedSamples,
      energy_consistency: Math.round(energyConsistency * 1000) / 1000,
      mean_speech_rms: Math.round(meanSpeechRms),
      sudden_drops: suddenDrops,
      sudden_spikes: suddenSpikes,
      clean_start: cleanStart,
      clean_end: cleanEnd,
      estimated_snr_db: estimatedSnrDb,
      speech_windows: speechWindows.length,
      silence_windows: silenceWindows.length,
    },
    duration_ms: durationMs,
    ...(!passed && { error: errors.join("; ") }),
  };
}
