/**
 * Metric orchestrator — computes all transcript + latency + audio analysis + harness overhead metrics.
 */

import type {
  ConversationTurn,
  LatencyMetrics,
  AudioAnalysisMetrics,
  HarnessOverhead,
} from "@vent/shared";
import { computeLatencyMetrics, computeHarnessOverhead } from "./latency.js";
import { computeAudioAnalysisMetrics, type TurnAudioData } from "./audio-analysis.js";

export interface ComputedMetrics {
  latency: LatencyMetrics;
  audio_analysis: AudioAnalysisMetrics | undefined;
  harness_overhead: HarnessOverhead | undefined;
}

/**
 * Compute all non-LLM metrics from conversation turns.
 */
export async function computeAllMetrics(
  turns: ConversationTurn[],
  turnAudioData?: TurnAudioData[],
  connectLatencyMs?: number,
): Promise<ComputedMetrics> {
  const latency = computeLatencyMetrics(turns, connectLatencyMs);
  const harness_overhead = computeHarnessOverhead(turns);

  // VAD-derived audio analysis (when turn audio data is available)
  const audio_analysis =
    turnAudioData && turnAudioData.length > 0
      ? computeAudioAnalysisMetrics(turnAudioData)
      : undefined;

  return { latency, audio_analysis, harness_overhead };
}

export { computeLatencyMetrics, computeHarnessOverhead } from "./latency.js";
export { computeAudioAnalysisMetrics, type TurnAudioData } from "./audio-analysis.js";
export { analyzeProsody } from "./prosody.js";
