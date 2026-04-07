/**
 * VAD-derived audio analysis metrics.
 *
 * Computes talk ratio, monologue detection, silence gap analysis, and
 * per-turn speech patterns from batch VAD speech segments.
 */

import type { AudioAnalysisMetrics, AudioAnalysisGradeThresholds, AudioAnalysisWarning } from "@vent/shared";
import type { SpeechSegment } from "@vent/voice";

export interface TurnAudioData {
  role: "caller" | "agent";
  /** Audio timeline start in ms relative to call start. */
  audioStartTimestampMs: number;
  audioDurationMs: number;
  /** Speech segments from batch VAD (agent) or synthetic full-span speech (caller fallback). */
  speechSegments?: SpeechSegment[];
  callerDecisionMode?: "continue" | "wait" | "closing" | "end_now";
  interrupted?: boolean;
  isInterruption?: boolean;
}

const SILENCE_GAP_THRESHOLD_MS = 2000;
const OVERLAP_THRESHOLD_MS = 150;
const MISSED_RESPONSE_WINDOW_THRESHOLD_MS = 2000;

/**
 * Compute VAD-derived audio analysis metrics from per-turn audio data.
 * Caller turns don't need VAD (TTS output is 100% speech).
 * Agent turns have speech segments from batch VAD analysis.
 */
export function computeAudioAnalysisMetrics(
  turns: TurnAudioData[]
): AudioAnalysisMetrics {
  const agentTurns = turns.filter((t) => t.role === "agent" && t.speechSegments);
  const callerTurns = turns.filter((t) => t.role === "caller");

  const totalCallerAudioMs = callerTurns.reduce((sum, t) => sum + t.audioDurationMs, 0);
  const totalAgentAudioMs = agentTurns.reduce((sum, t) => sum + t.audioDurationMs, 0);

  // Collect all agent speech segments and compute per-turn stats
  let totalAgentSpeechMs = 0;
  let longestMonologueMs = 0;
  let silenceGapsOver2s = 0;
  let totalInternalSilenceMs = 0;
  const perTurnSpeechSegments: number[] = [];
  const perTurnInternalSilenceMs: number[] = [];
  const allSegmentDurations: number[] = [];

  for (const turn of agentTurns) {
    const segments = turn.speechSegments!;
    perTurnSpeechSegments.push(segments.length);

    let turnSpeechMs = 0;
    let turnInternalSilenceMs = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const segDuration = seg.endMs - seg.startMs;
      turnSpeechMs += segDuration;
      allSegmentDurations.push(segDuration);

      // Track longest monologue
      if (segDuration > longestMonologueMs) {
        longestMonologueMs = segDuration;
      }

      // Compute gap to next segment (internal silence)
      if (i < segments.length - 1) {
        const gap = segments[i + 1]!.startMs - seg.endMs;
        if (gap > 0) {
          turnInternalSilenceMs += gap;
          if (gap >= SILENCE_GAP_THRESHOLD_MS) {
            silenceGapsOver2s++;
          }
        }
      }
    }

    totalAgentSpeechMs += turnSpeechMs;
    totalInternalSilenceMs += turnInternalSilenceMs;
    perTurnInternalSilenceMs.push(Math.round(turnInternalSilenceMs));
  }

  // Agent speech ratio: how much of agent's air time is actual speech
  const agentSpeechRatio =
    totalAgentAudioMs > 0 ? totalAgentSpeechMs / totalAgentAudioMs : 0;

  // VAD-corrected talk ratio: caller time / (caller time + agent SPEECH time)
  const totalSpeechMs = totalCallerAudioMs + totalAgentSpeechMs;
  const talkRatioVad =
    totalSpeechMs > 0 ? totalCallerAudioMs / totalSpeechMs : 0;

  // Mean segment duration
  const meanSegmentMs =
    allSegmentDurations.length > 0
      ? allSegmentDurations.reduce((a, b) => a + b, 0) / allSegmentDurations.length
      : 0;

  let interruptionOpportunities = 0;
  let interruptionCount = 0;
  const bargeInRecoverySamples: number[] = [];
  let agentInterruptOpportunities = 0;
  let agentInterruptingUserCount = 0;
  let missedResponseWindows = 0;

  for (let i = 1; i < turns.length; i++) {
    const previous = turns[i - 1]!;
    const current = turns[i]!;

    if (current.role === "caller" && previous.role === "agent") {
      const callerSpeech = getSpeechIntervals(current);
      const agentSpeech = getSpeechIntervals(previous);
      if (callerSpeech.length > 0 && agentSpeech.length > 0) {
        interruptionOpportunities++;
        const overlapMs = Math.round(
          Math.max(0, getLastSpeechEndMs(previous)! - callerSpeech[0]!.start)
        );
        if (overlapMs > OVERLAP_THRESHOLD_MS) {
          interruptionCount++;
          bargeInRecoverySamples.push(overlapMs);
        }
      }
    }

    if (current.role === "agent" && previous.role === "caller") {
      const callerSpeech = getSpeechIntervals(previous);
      if (callerSpeech.length === 0 || previous.callerDecisionMode === "end_now") {
        continue;
      }

      agentInterruptOpportunities++;
      const agentSpeechStartMs = getFirstSpeechStartMs(current);
      const callerSpeechEndMs = callerSpeech[callerSpeech.length - 1]!.end;

      if (agentSpeechStartMs == null) {
        missedResponseWindows++;
        continue;
      }

      const overlapMs = Math.round(Math.max(0, callerSpeechEndMs - agentSpeechStartMs));
      if (overlapMs > OVERLAP_THRESHOLD_MS) {
        agentInterruptingUserCount++;
      }

      const responseGapMs = Math.round(agentSpeechStartMs - callerSpeechEndMs);
      if (responseGapMs >= MISSED_RESPONSE_WINDOW_THRESHOLD_MS) {
        missedResponseWindows++;
      }
    }
  }

  return {
    caller_talk_time_ms: Math.round(totalCallerAudioMs),
    agent_talk_time_ms: Math.round(totalAgentSpeechMs),
    agent_speech_ratio: round3(agentSpeechRatio),
    talk_ratio_vad: round3(talkRatioVad),
    interruption_rate: ratio(interruptionCount, interruptionOpportunities),
    interruption_count: interruptionCount,
    agent_overtalk_after_barge_in_ms: mean(bargeInRecoverySamples),
    agent_interrupting_user_rate: ratio(agentInterruptingUserCount, agentInterruptOpportunities),
    agent_interrupting_user_count: agentInterruptingUserCount,
    missed_response_windows: missedResponseWindows,
    longest_monologue_ms: Math.round(longestMonologueMs),
    silence_gaps_over_2s: silenceGapsOver2s,
    total_internal_silence_ms: Math.round(totalInternalSilenceMs),
    per_turn_speech_segments: perTurnSpeechSegments,
    per_turn_internal_silence_ms: perTurnInternalSilenceMs,
    mean_agent_speech_segment_ms: Math.round(meanSegmentMs),
  };
}

/**
 * Grade audio analysis metrics against configurable thresholds.
 * Returns warnings (informational — does NOT affect conversation call pass/fail).
 */
export function gradeAudioAnalysisMetrics(
  metrics: AudioAnalysisMetrics,
  thresholds?: AudioAnalysisGradeThresholds,
): AudioAnalysisWarning[] {
  const t = {
    agent_speech_ratio_min: thresholds?.agent_speech_ratio_min ?? 0.5,
    talk_ratio_vad_max: thresholds?.talk_ratio_vad_max ?? 0.7,
    talk_ratio_vad_min: thresholds?.talk_ratio_vad_min ?? 0.3,
    longest_monologue_max_ms: thresholds?.longest_monologue_max_ms ?? 30000,
    silence_gaps_over_2s_max: thresholds?.silence_gaps_over_2s_max ?? 3,
    mean_segment_min_ms: thresholds?.mean_segment_min_ms ?? 500,
    mean_segment_max_ms: thresholds?.mean_segment_max_ms ?? 20000,
  };

  const warnings: AudioAnalysisWarning[] = [];

  if (metrics.agent_speech_ratio < t.agent_speech_ratio_min) {
    warnings.push({
      metric: "agent_speech_ratio",
      value: metrics.agent_speech_ratio,
      threshold: t.agent_speech_ratio_min,
      severity: metrics.agent_speech_ratio < 0.3 ? "critical" : "warning",
      message: `Agent speech ratio ${metrics.agent_speech_ratio} below ${t.agent_speech_ratio_min} — agent audio is mostly silence`,
    });
  }

  if (metrics.talk_ratio_vad > t.talk_ratio_vad_max) {
    warnings.push({
      metric: "talk_ratio_vad",
      value: metrics.talk_ratio_vad,
      threshold: t.talk_ratio_vad_max,
      severity: "warning",
      message: `Talk ratio ${metrics.talk_ratio_vad} exceeds ${t.talk_ratio_vad_max} — caller dominates, agent not contributing enough`,
    });
  }

  if (metrics.talk_ratio_vad < t.talk_ratio_vad_min) {
    warnings.push({
      metric: "talk_ratio_vad",
      value: metrics.talk_ratio_vad,
      threshold: t.talk_ratio_vad_min,
      severity: "warning",
      message: `Talk ratio ${metrics.talk_ratio_vad} below ${t.talk_ratio_vad_min} — agent monologuing`,
    });
  }

  if (metrics.longest_monologue_ms > t.longest_monologue_max_ms) {
    warnings.push({
      metric: "longest_monologue_ms",
      value: metrics.longest_monologue_ms,
      threshold: t.longest_monologue_max_ms,
      severity: "warning",
      message: `Longest monologue ${metrics.longest_monologue_ms}ms exceeds ${t.longest_monologue_max_ms}ms`,
    });
  }

  if (metrics.silence_gaps_over_2s > t.silence_gaps_over_2s_max) {
    warnings.push({
      metric: "silence_gaps_over_2s",
      value: metrics.silence_gaps_over_2s,
      threshold: t.silence_gaps_over_2s_max,
      severity: metrics.silence_gaps_over_2s > 5 ? "critical" : "warning",
      message: `${metrics.silence_gaps_over_2s} silence gaps >2s (max ${t.silence_gaps_over_2s_max})`,
    });
  }

  if (metrics.mean_agent_speech_segment_ms > 0 && metrics.mean_agent_speech_segment_ms < t.mean_segment_min_ms) {
    warnings.push({
      metric: "mean_agent_speech_segment_ms",
      value: metrics.mean_agent_speech_segment_ms,
      threshold: t.mean_segment_min_ms,
      severity: "warning",
      message: `Mean speech segment ${metrics.mean_agent_speech_segment_ms}ms below ${t.mean_segment_min_ms}ms — choppy audio`,
    });
  }

  if (metrics.mean_agent_speech_segment_ms > t.mean_segment_max_ms) {
    warnings.push({
      metric: "mean_agent_speech_segment_ms",
      value: metrics.mean_agent_speech_segment_ms,
      threshold: t.mean_segment_max_ms,
      severity: "warning",
      message: `Mean speech segment ${metrics.mean_agent_speech_segment_ms}ms exceeds ${t.mean_segment_max_ms}ms`,
    });
  }

  return warnings;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function ratio(count: number, total: number): number {
  if (total <= 0) return 0;
  return round3(count / total);
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function getSpeechIntervals(turn: TurnAudioData): Array<{ start: number; end: number }> {
  if (turn.audioDurationMs <= 0) return [];

  if (turn.role === "agent") {
    if (!turn.speechSegments || turn.speechSegments.length === 0) return [];
    return turn.speechSegments.map((segment) => ({
      start: turn.audioStartTimestampMs + segment.startMs,
      end: turn.audioStartTimestampMs + segment.endMs,
    }));
  }

  return [{
    start: turn.audioStartTimestampMs,
    end: turn.audioStartTimestampMs + turn.audioDurationMs,
  }];
}

function getFirstSpeechStartMs(turn: TurnAudioData): number | undefined {
  return getSpeechIntervals(turn)[0]?.start;
}

function getLastSpeechEndMs(turn: TurnAudioData): number | undefined {
  const intervals = getSpeechIntervals(turn);
  return intervals.length > 0 ? intervals[intervals.length - 1]!.end : undefined;
}
