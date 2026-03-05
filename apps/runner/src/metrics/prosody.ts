/**
 * Prosody analysis via Hume Expression Measurement API.
 * Analyzes emotional tone, rhythm, and timbre of agent speech.
 * Opt-in, informational-only — never affects test pass/fail.
 */

import type {
  TurnEmotionProfile,
  ProsodyMetrics,
  ProsodyWarning,
} from "@voiceci/shared";
import { withRetry } from "@voiceci/shared";
import { pcmToWav } from "@voiceci/voice";
import { HumeClient, HumeError, HumeTimeoutError } from "hume";

// ============================================================
// Hume API types
// ============================================================

interface HumeEmotion {
  name: string;
  score: number;
}

interface HumeProsodyPrediction {
  text?: string;
  time: { begin: number; end: number };
  confidence?: number;
  speakerConfidence?: number;
  emotions: HumeEmotion[];
}

interface HumeProsodyGroupedPrediction {
  id: string;
  predictions: HumeProsodyPrediction[];
}

interface HumeJobState {
  status: "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  message?: string;
}

interface HumeBatchJob {
  jobId: string;
  awaitCompletion(timeoutInSeconds?: number): Promise<void>;
}

// ============================================================
// Constants
// ============================================================

const HUME_MAX_WAIT_SECONDS = 120;

// Composite emotion mappings from Hume's 48 emotion dimensions
const CALMNESS_EMOTIONS = ["Calmness", "Contentment"];
const CONFIDENCE_EMOTIONS = ["Confidence", "Determination"];
const FRUSTRATION_EMOTIONS = ["Anger", "Annoyance", "Contempt"];
const WARMTH_EMOTIONS = ["Sympathy", "Care"];
const UNCERTAINTY_EMOTIONS = ["Confusion", "Doubt", "Anxiety"];

// ============================================================
// Hume API client
// ============================================================

async function startHumeJob(
  client: HumeClient,
  turnWavBuffers: Buffer[],
): Promise<HumeBatchJob> {
  return withRetry(async () => {
    try {
      return await client.expressionMeasurement.batch.startInferenceJobFromLocalFile(
        {
          json: {
            models: {
              prosody: {
                granularity: "utterance",
                identifySpeakers: false,
              },
            },
          },
          file: turnWavBuffers.map((wavBuffer, i) => ({
            data: wavBuffer,
            filename: `turn_${i}.wav`,
            contentType: "audio/wav",
          })),
        },
      );
    } catch (err) {
      const statusCode = err instanceof HumeError ? err.statusCode : undefined;
      const retryable =
        err instanceof HumeTimeoutError ||
        statusCode === 429 ||
        (statusCode !== undefined && statusCode >= 500);

      if (retryable) {
        const msg = err instanceof Error ? err.message : String(err);
        throw Object.assign(new Error(`Hume start job retryable: ${msg}`), {
          retryable: true,
        });
      }

      throw err;
    }
  });
}

async function awaitHumeJobCompletion(
  client: HumeClient,
  job: HumeBatchJob,
): Promise<HumeJobState> {
  await job.awaitCompletion(HUME_MAX_WAIT_SECONDS);
  const details = await client.expressionMeasurement.batch.getJobDetails(job.jobId);
  return details.state as HumeJobState;
}

async function getHumePredictions(
  client: HumeClient,
  jobId: string,
): Promise<HumeProsodyGroupedPrediction[][]> {
  const data = await client.expressionMeasurement.batch.getJobPredictions(jobId);
  return data.map(
    (file) =>
      file.results?.predictions[0]?.models.prosody?.groupedPredictions ?? [],
  );
}

// ============================================================
// Emotion computation
// ============================================================

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function avgEmotions(
  emotions: HumeEmotion[],
  targetNames: string[],
): number {
  const matches = emotions.filter((e) => targetNames.includes(e.name));
  if (matches.length === 0) return 0;
  return round3(matches.reduce((sum, e) => sum + e.score, 0) / matches.length);
}

function buildTurnProfile(
  turnIndex: number,
  predictions: HumeProsodyPrediction[],
): TurnEmotionProfile {
  // Average emotion scores across all utterances in this turn
  const emotionTotals = new Map<string, { sum: number; count: number }>();
  for (const pred of predictions) {
    for (const e of pred.emotions) {
      const entry = emotionTotals.get(e.name) ?? { sum: 0, count: 0 };
      entry.sum += e.score;
      entry.count += 1;
      emotionTotals.set(e.name, entry);
    }
  }

  const avgScores: HumeEmotion[] = [];
  for (const [name, { sum, count }] of emotionTotals) {
    avgScores.push({ name, score: sum / count });
  }

  const emotions: Record<string, number> = {};
  for (const e of avgScores) {
    emotions[e.name] = round3(e.score);
  }

  return {
    turn_index: turnIndex,
    emotions,
    calmness: avgEmotions(avgScores, CALMNESS_EMOTIONS),
    confidence: avgEmotions(avgScores, CONFIDENCE_EMOTIONS),
    frustration: avgEmotions(avgScores, FRUSTRATION_EMOTIONS),
    warmth: avgEmotions(avgScores, WARMTH_EMOTIONS),
    uncertainty: avgEmotions(avgScores, UNCERTAINTY_EMOTIONS),
  };
}

function computeAggregates(
  perTurn: TurnEmotionProfile[],
  humeLatencyMs: number,
): ProsodyMetrics {
  if (perTurn.length === 0) {
    return {
      per_turn: [],
      mean_calmness: 0,
      mean_confidence: 0,
      peak_frustration: 0,
      emotion_consistency: 0,
      naturalness: 0,
      emotion_trajectory: "stable",
      hume_latency_ms: humeLatencyMs,
    };
  }

  const meanCalmness = round3(
    perTurn.reduce((s, t) => s + t.calmness, 0) / perTurn.length,
  );
  const meanConfidence = round3(
    perTurn.reduce((s, t) => s + t.confidence, 0) / perTurn.length,
  );
  const peakFrustration = round3(
    Math.max(...perTurn.map((t) => t.frustration)),
  );

  // Emotion consistency: low std dev of dominant emotion = consistent
  const dominantScores = perTurn.map((t) => {
    const scores = Object.values(t.emotions);
    return scores.length > 0 ? Math.max(...scores) : 0;
  });
  const meanDominant =
    dominantScores.reduce((a, b) => a + b, 0) / dominantScores.length;
  const variance =
    dominantScores.reduce((s, v) => s + (v - meanDominant) ** 2, 0) /
    dominantScores.length;
  const emotionConsistency = round3(1 - Math.min(1, Math.sqrt(variance)));

  // Naturalness: weighted composite
  const naturalness = round3(
    Math.max(
      0,
      Math.min(
        1,
        meanCalmness * 0.3 +
          meanConfidence * 0.3 +
          emotionConsistency * 0.2 +
          (1 - peakFrustration) * 0.2,
      ),
    ),
  );

  // Emotion trajectory: compare first half vs second half calmness
  const mid = Math.ceil(perTurn.length / 2);
  const firstHalfCalm =
    perTurn.slice(0, mid).reduce((s, t) => s + t.calmness, 0) / mid;
  const secondHalfCalm =
    perTurn.slice(mid).reduce((s, t) => s + t.calmness, 0) /
    (perTurn.length - mid);
  const calmDelta = secondHalfCalm - firstHalfCalm;

  let emotion_trajectory: ProsodyMetrics["emotion_trajectory"];
  if (Math.abs(calmDelta) < 0.05) emotion_trajectory = "stable";
  else if (calmDelta > 0.1) emotion_trajectory = "improving";
  else if (calmDelta < -0.1) emotion_trajectory = "degrading";
  else emotion_trajectory = "volatile";

  return {
    per_turn: perTurn,
    mean_calmness: meanCalmness,
    mean_confidence: meanConfidence,
    peak_frustration: peakFrustration,
    emotion_consistency: emotionConsistency,
    naturalness,
    emotion_trajectory,
    hume_latency_ms: humeLatencyMs,
  };
}

// ============================================================
// Grading
// ============================================================

/**
 * Grade prosody metrics against thresholds.
 * Returns warnings (informational — does NOT affect pass/fail).
 */
export function gradeProsodyMetrics(
  metrics: ProsodyMetrics,
): ProsodyWarning[] {
  const warnings: ProsodyWarning[] = [];

  if (metrics.mean_calmness < 0.3) {
    warnings.push({
      metric: "mean_calmness",
      value: metrics.mean_calmness,
      threshold: 0.3,
      severity: metrics.mean_calmness < 0.15 ? "critical" : "warning",
      message: `Agent mean calmness ${metrics.mean_calmness} is low — voice sounds tense or agitated`,
    });
  }

  if (metrics.mean_confidence < 0.25) {
    warnings.push({
      metric: "mean_confidence",
      value: metrics.mean_confidence,
      threshold: 0.25,
      severity: "warning",
      message: `Agent mean confidence ${metrics.mean_confidence} is low — voice sounds hesitant or uncertain`,
    });
  }

  if (metrics.peak_frustration > 0.5) {
    warnings.push({
      metric: "peak_frustration",
      value: metrics.peak_frustration,
      threshold: 0.5,
      severity: metrics.peak_frustration > 0.7 ? "critical" : "warning",
      message: `Peak frustration ${metrics.peak_frustration} detected — agent voice sounded frustrated or angry`,
    });
  }

  if (metrics.emotion_consistency < 0.4) {
    warnings.push({
      metric: "emotion_consistency",
      value: metrics.emotion_consistency,
      threshold: 0.4,
      severity: "warning",
      message: `Emotion consistency ${metrics.emotion_consistency} — agent voice tone is erratic across turns`,
    });
  }

  if (metrics.naturalness < 0.4) {
    warnings.push({
      metric: "naturalness",
      value: metrics.naturalness,
      threshold: 0.4,
      severity: metrics.naturalness < 0.25 ? "critical" : "warning",
      message: `Naturalness score ${metrics.naturalness} — agent voice sounds robotic or unnatural`,
    });
  }

  if (metrics.emotion_trajectory === "degrading") {
    warnings.push({
      metric: "emotion_trajectory",
      value: 0,
      threshold: 0,
      severity: "warning",
      message: "Emotional trajectory is degrading — agent became less calm over the conversation",
    });
  }

  return warnings;
}

// ============================================================
// Public entry point
// ============================================================

/**
 * Run Hume prosody analysis on per-turn agent audio buffers.
 * Returns null if HUME_API_KEY is not set or analysis fails.
 * Designed to run concurrently with judge evaluation.
 */
export async function analyzeProsody(
  agentAudioBuffers: Buffer[],
): Promise<{ metrics: ProsodyMetrics; warnings: ProsodyWarning[] } | null> {
  const apiKey = process.env["HUME_API_KEY"];
  if (!apiKey) {
    console.log("    Prosody analysis skipped: HUME_API_KEY not set");
    return null;
  }

  // Filter out empty buffers
  const nonEmpty = agentAudioBuffers.filter((b) => b.length > 0);
  if (nonEmpty.length === 0) {
    return null;
  }

  const start = performance.now();

  try {
    // Convert each turn's PCM to WAV
    const wavBuffers = nonEmpty.map((pcm) => pcmToWav(pcm));
    const hume = new HumeClient({ apiKey });

    // Submit batch job
    const job = await startHumeJob(hume, wavBuffers);
    console.log(`    Hume prosody job started: ${job.jobId}`);

    // Poll until complete
    const state = await awaitHumeJobCompletion(hume, job);
    if (state.status === "FAILED") {
      console.warn(`    Hume prosody job failed: ${state.message}`);
      return null;
    }

    // Fetch predictions
    const perFilePredictions = await getHumePredictions(hume, job.jobId);

    // Build per-turn emotion profiles
    const turnProfiles: TurnEmotionProfile[] = [];
    for (let i = 0; i < perFilePredictions.length; i++) {
      const groups = perFilePredictions[i];
      if (!groups || groups.length === 0) continue;

      const allPredictions = groups.flatMap((g) => g.predictions);
      if (allPredictions.length === 0) continue;

      turnProfiles.push(buildTurnProfile(i, allPredictions));
    }

    const humeLatencyMs = Math.round(performance.now() - start);
    const metrics = computeAggregates(turnProfiles, humeLatencyMs);
    const warnings = gradeProsodyMetrics(metrics);

    console.log(
      `    Prosody analysis complete: ${turnProfiles.length} turns, naturalness=${metrics.naturalness} (${humeLatencyMs}ms)`,
    );

    return { metrics, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`    Prosody analysis failed (non-fatal): ${msg}`);
    return null;
  }
}
