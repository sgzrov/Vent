/**
 * Metric orchestrator — computes all transcript + latency + audio analysis + harness overhead metrics.
 */

import type {
  ConversationTurn,
  TranscriptMetrics,
  LatencyMetrics,
  AudioAnalysisMetrics,
  HarnessOverhead,
} from "@voiceci/shared";
import { computeTranscriptMetrics } from "./transcript.js";
import { computeLatencyMetrics, computeHarnessOverhead } from "./latency.js";
import { computeAudioAnalysisMetrics, type TurnAudioData } from "./audio-analysis.js";

export interface ComputedMetrics {
  transcript: TranscriptMetrics;
  latency: LatencyMetrics;
  talk_ratio: number | undefined;
  audio_analysis: AudioAnalysisMetrics | undefined;
  harness_overhead: HarnessOverhead | undefined;
}

/**
 * Compute all non-LLM metrics from conversation turns.
 * These are pure, instant computations with no external calls.
 */
export function computeAllMetrics(
  turns: ConversationTurn[],
  turnAudioData?: TurnAudioData[],
  connectLatencyMs?: number,
): ComputedMetrics {
  const transcript = computeTranscriptMetrics(turns);
  const latency = computeLatencyMetrics(turns, connectLatencyMs);
  const harness_overhead = computeHarnessOverhead(turns);

  // Talk ratio: caller audio duration / total audio duration
  const callerAudioMs = turns
    .filter((t) => t.role === "caller")
    .reduce((sum, t) => sum + (t.audio_duration_ms ?? 0), 0);
  const agentAudioMs = turns
    .filter((t) => t.role === "agent")
    .reduce((sum, t) => sum + (t.audio_duration_ms ?? 0), 0);
  const totalAudioMs = callerAudioMs + agentAudioMs;
  const talk_ratio = totalAudioMs > 0 ? callerAudioMs / totalAudioMs : undefined;

  // VAD-derived audio analysis (when turn audio data is available)
  const audio_analysis =
    turnAudioData && turnAudioData.length > 0
      ? computeAudioAnalysisMetrics(turnAudioData)
      : undefined;

  return { transcript, latency, talk_ratio, audio_analysis, harness_overhead };
}

export { computeTranscriptMetrics } from "./transcript.js";
export { computeLatencyMetrics, computeHarnessOverhead } from "./latency.js";
export { computeAudioAnalysisMetrics, type TurnAudioData } from "./audio-analysis.js";
export { analyzeProsody, gradeProsodyMetrics } from "./prosody.js";
