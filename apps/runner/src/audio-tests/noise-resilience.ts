/**
 * Noise Resilience test — measures agent robustness under background noise.
 *
 * Procedure:
 * 1. Send clean baseline prompt, record TTFB
 * 2. Run 9 trials: 3 noise types (white, babble, pink) x 3 SNR levels (20, 10, 5 dB)
 * 3. For each trial, mix noise with clean audio and check if agent responds
 * 4. PASS if agent responds at all trials with SNR >= min_pass_snr_db
 */

import type { AudioChannel } from "@voiceci/adapters";
import type { AudioTestResult, AudioTestThresholds } from "@voiceci/shared";
import { synthesize, generateWhiteNoise, generateBabbleNoise, generatePinkNoise, mixAudio } from "@voiceci/voice";
import { waitForSpeech, collectUntilEndOfTurn } from "./helpers.js";
import { generateSilence } from "./signals.js";

const DEFAULT_MIN_PASS_SNR_DB = 10;
const DEFAULT_MAX_TTFB_DEGRADATION_MS = 2000;
const BASELINE_PROMPT = "Hi, can you tell me what services you offer?";
const TRIAL_PROMPTS = [
  "What are your hours of operation?",
  "Where are you located?",
  "Do you accept walk-in appointments?",
  "How much does a basic appointment cost?",
  "Can I speak to someone about my account?",
  "What payment methods do you accept?",
  "Do you have any availability this week?",
  "Are you open on weekends?",
  "Can you tell me about your cancellation policy?",
];
const SNR_LEVELS = [20, 10, 5] as const;
const NOISE_TYPES = ["white", "babble", "pink"] as const;
type NoiseType = (typeof NOISE_TYPES)[number];

const NOISE_GENERATORS: Record<NoiseType, (ms: number) => Buffer> = {
  white: generateWhiteNoise,
  babble: generateBabbleNoise,
  pink: generatePinkNoise,
};

interface TrialResult {
  noiseType: NoiseType;
  snrDb: number;
  responded: boolean;
  ttfbMs: number;
}

export async function runNoiseResilienceTest(
  channel: AudioChannel,
  thresholds?: AudioTestThresholds,
): Promise<AudioTestResult> {
  const MIN_PASS_SNR = thresholds?.noise_resilience?.min_pass_snr_db ?? DEFAULT_MIN_PASS_SNR_DB;
  const startTime = performance.now();

  // Phase 0: Baseline (clean audio)
  const baselineAudio = await synthesize(BASELINE_PROMPT);

  const baselineSendTime = Date.now();
  channel.sendAudio(baselineAudio);

  const baselineSpeech = await waitForSpeech(channel, 10000);
  if (baselineSpeech.timedOut) {
    return {
      test_name: "noise_resilience",
      status: "fail",
      metrics: { baseline_responded: false },
      duration_ms: Math.round(performance.now() - startTime),
      error: "Agent did not respond to clean baseline prompt",
    };
  }

  const baselineTtfb = baselineSpeech.detectedAt - baselineSendTime;
  await collectUntilEndOfTurn(channel, { timeoutMs: 15000, silenceThresholdMs: 1500 });

  // Phase 1: Noisy trials — each trial uses a different prompt to avoid context confusion
  const trials: TrialResult[] = [];
  let trialIndex = 0;

  for (const noiseType of NOISE_TYPES) {
    for (const snrDb of SNR_LEVELS) {
      // Brief silence between trials to reset agent state
      channel.sendAudio(generateSilence(500));
      await new Promise((r) => setTimeout(r, 500));

      const trialPrompt = TRIAL_PROMPTS[trialIndex % TRIAL_PROMPTS.length]!;
      trialIndex++;
      const cleanAudio = await synthesize(trialPrompt);
      const cleanDurationMs = Math.round((cleanAudio.length / 2 / 24000) * 1000);
      const noise = NOISE_GENERATORS[noiseType](cleanDurationMs);
      const noisyAudio = mixAudio(cleanAudio, noise, snrDb);

      const sendTime = Date.now();
      channel.sendAudio(noisyAudio);

      const speech = await waitForSpeech(channel, 10000);
      const responded = !speech.timedOut;
      const ttfbMs = responded ? speech.detectedAt - sendTime : 0;

      if (responded) {
        await collectUntilEndOfTurn(channel, { timeoutMs: 15000, silenceThresholdMs: 2000 });
      }

      trials.push({ noiseType, snrDb, responded, ttfbMs });
    }
  }

  // Evaluate results
  const trialsAtThreshold = trials.filter((t) => t.snrDb >= MIN_PASS_SNR);
  const trialsAtThresholdResponded = trialsAtThreshold.filter((t) => t.responded).length;
  const allAtThresholdPassed = trialsAtThresholdResponded === trialsAtThreshold.length;

  const respondedTrials = trials.filter((t) => t.responded);
  const ttfbDegradations = respondedTrials.map((t) => t.ttfbMs - baselineTtfb);
  const worstDegradation = ttfbDegradations.length > 0 ? Math.max(...ttfbDegradations) : 0;
  const meanDegradation =
    ttfbDegradations.length > 0
      ? Math.round(ttfbDegradations.reduce((a, b) => a + b, 0) / ttfbDegradations.length)
      : 0;

  // Find lowest SNR that still got a response
  const respondedSnrs = trials.filter((t) => t.responded).map((t) => t.snrDb);
  const minRespondingSnr = respondedSnrs.length > 0 ? Math.min(...respondedSnrs) : -1;

  const passed = allAtThresholdPassed;
  const durationMs = Math.round(performance.now() - startTime);

  // Build per-trial booleans for metrics
  const perTrialMetrics: Record<string, boolean> = {};
  for (const t of trials) {
    perTrialMetrics[`${t.noiseType}_${t.snrDb}db_responded`] = t.responded;
  }

  return {
    test_name: "noise_resilience",
    status: passed ? "pass" : "fail",
    metrics: {
      baseline_ttfb_ms: Math.round(baselineTtfb),
      trials_total: trials.length,
      trials_responded: respondedTrials.length,
      trials_at_threshold_responded: trialsAtThresholdResponded,
      trials_at_threshold_total: trialsAtThreshold.length,
      worst_ttfb_degradation_ms: Math.round(worstDegradation),
      mean_ttfb_degradation_ms: meanDegradation,
      min_responding_snr_db: minRespondingSnr,
      ...perTrialMetrics,
    },
    duration_ms: durationMs,
    ...(!passed && {
      error: `Agent failed to respond at SNR >= ${MIN_PASS_SNR}dB (${trialsAtThresholdResponded}/${trialsAtThreshold.length} trials responded)`,
    }),
  };
}
