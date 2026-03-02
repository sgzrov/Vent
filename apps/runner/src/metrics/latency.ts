/**
 * Latency metrics — percentiles, turn gaps, silence detection, harness overhead.
 */

import type { ConversationTurn, LatencyMetrics, HarnessOverhead } from "@voiceci/shared";

/**
 * Compute percentile from a sorted array of numbers.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Compute latency metrics from conversation turns.
 * Expects turns to have ttfb_ms (and optionally ttfw_ms, silence_pad_ms) populated on agent turns.
 */
export function computeLatencyMetrics(turns: ConversationTurn[], connectLatencyMs?: number): LatencyMetrics {
  const agentTurns = turns.filter((t) => t.role === "agent");
  const ttfbValues = agentTurns
    .map((t) => t.ttfb_ms)
    .filter((v): v is number => v !== undefined);

  const sorted = [...ttfbValues].sort((a, b) => a - b);

  // TTFW (time to first word — VAD speech onset)
  const ttfwValues = agentTurns
    .map((t) => t.ttfw_ms)
    .filter((v): v is number => v !== undefined);

  const sortedTtfw = [...ttfwValues].sort((a, b) => a - b);

  // Silence pad (TTFW - TTFB — dead audio before speech)
  const silencePadValues = agentTurns
    .map((t) => t.silence_pad_ms)
    .filter((v): v is number => v !== undefined);

  // Turn gaps: time between end of one turn and start of next
  const turnGaps: number[] = [];
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1]!;
    const curr = turns[i]!;
    const prevEnd = prev.timestamp_ms + (prev.audio_duration_ms ?? 0);
    const gap = curr.timestamp_ms - prevEnd;
    if (gap > 0) turnGaps.push(gap);
  }

  // Total silence: sum of gaps where no one is talking
  const totalSilenceMs = turnGaps.reduce((sum, g) => sum + g, 0);

  const meanTurnGapMs = turnGaps.length > 0
    ? turnGaps.reduce((sum, g) => sum + g, 0) / turnGaps.length
    : 0;

  // Base TTFB metrics (always present)
  const result: LatencyMetrics = {
    ttfb_per_turn_ms: ttfbValues,
    p50_ttfb_ms: percentile(sorted, 50),
    p90_ttfb_ms: percentile(sorted, 90),
    p95_ttfb_ms: percentile(sorted, 95),
    p99_ttfb_ms: percentile(sorted, 99),
    first_turn_ttfb_ms: ttfbValues[0] ?? 0,
    total_silence_ms: totalSilenceMs,
    mean_turn_gap_ms: meanTurnGapMs,
  };

  // TTFW metrics (only when data exists)
  if (ttfwValues.length > 0) {
    result.ttfw_per_turn_ms = ttfwValues;
    result.p50_ttfw_ms = percentile(sortedTtfw, 50);
    result.p90_ttfw_ms = percentile(sortedTtfw, 90);
    result.p95_ttfw_ms = percentile(sortedTtfw, 95);
    result.p99_ttfw_ms = percentile(sortedTtfw, 99);
    result.first_turn_ttfw_ms = ttfwValues[0] ?? 0;
  }

  // Silence pad (only when data exists)
  if (silencePadValues.length > 0) {
    result.mean_silence_pad_ms = mean(silencePadValues);
  }

  // Mouth-to-ear estimate (only when both TTFW and connect latency exist)
  if (ttfwValues.length > 0 && connectLatencyMs != null && connectLatencyMs > 0) {
    result.mouth_to_ear_est_ms = mean(ttfwValues) + Math.round(connectLatencyMs);
  }

  return result;
}

/**
 * Compute harness overhead — TTS and STT timing from test infrastructure.
 * These are VoiceCI's own API call durations, not the agent's internal timings.
 */
export function computeHarnessOverhead(turns: ConversationTurn[]): HarnessOverhead | undefined {
  const ttsValues = turns
    .filter((t) => t.role === "caller")
    .map((t) => t.tts_ms)
    .filter((v): v is number => v !== undefined);

  const sttValues = turns
    .filter((t) => t.role === "agent")
    .map((t) => t.stt_ms)
    .filter((v): v is number => v !== undefined);

  if (ttsValues.length === 0 && sttValues.length === 0) return undefined;

  return {
    tts_per_turn_ms: ttsValues,
    stt_per_turn_ms: sttValues,
    mean_tts_ms: mean(ttsValues),
    mean_stt_ms: mean(sttValues),
  };
}
