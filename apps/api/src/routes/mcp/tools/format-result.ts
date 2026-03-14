/**
 * Transforms raw ConversationTestResult into a structured, grouped format
 * for coding agent consumption via MCP.
 *
 * Groups metrics by concern and removes Vent internals (harness overhead,
 * Hume API timing, our TTS/STT processing time).
 */

import type {
  ConversationTestResult,
  ConversationTurn,
  ObservedToolCall,
  AudioActionResult,
  LatencyMetrics,
  BehavioralMetrics,
  TranscriptMetrics,
  AudioAnalysisMetrics,
  ProsodyMetrics,
  ToolCallMetrics,
  TurnEmotionProfile,
  LoadTestResult,
  LoadTestTierResult,
  LoadTestSeverity,
  LoadTestBreakingPoint,
  LoadTestGrading,
} from "@voiceci/shared";

// ---- Formatted types (MCP API-specific, not in shared) ----

interface FormattedTranscriptTurn {
  role: "caller" | "agent";
  text: string;
  ttfb_ms?: number;
  ttfw_ms?: number;
  stt_confidence?: number;
  audio_duration_ms?: number;
  silence_pad_ms?: number;
}

interface FormattedLatency {
  mean_ttfw_ms: number;
  p50_ttfw_ms: number;
  p95_ttfw_ms: number;
  p99_ttfw_ms: number;
  first_turn_ttfw_ms: number;
  total_silence_ms: number;
  mean_turn_gap_ms: number;
  ttfw_per_turn_ms: number[];
  drift_slope_ms_per_turn?: number;
  mean_silence_pad_ms?: number;
  mouth_to_ear_est_ms?: number;
}

interface FormattedAudioAnalysis {
  agent_speech_ratio: number;
  talk_ratio_vad: number;
  longest_monologue_ms: number;
  silence_gaps_over_2s: number;
  total_internal_silence_ms: number;
  mean_agent_speech_segment_ms: number;
}

interface FormattedToolCalls {
  total: number;
  successful: number;
  failed: number;
  mean_latency_ms?: number;
  names: string[];
  observed: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    successful?: boolean;
    latency_ms?: number;
  }>;
}

interface FormattedEmotion {
  mean_calmness: number;
  mean_confidence: number;
  peak_frustration: number;
  emotion_consistency: number;
  naturalness: number;
  emotion_trajectory: "stable" | "improving" | "degrading" | "volatile";
  per_turn: TurnEmotionProfile[];
}

interface FormattedBehavior {
  intent_accuracy?: { score: number; reasoning: string };
  context_retention?: { score: number; reasoning: string };
  topic_drift?: { score: number; reasoning: string };
  empathy_score?: { score: number; reasoning: string };
  hallucination_detected?: { detected: boolean; reasoning: string };
  safety_compliance?: { compliant: boolean; score?: number; reasoning: string };
  escalation_handling?: { triggered: boolean; handled_appropriately: boolean; score: number; reasoning: string };
}

export interface FormattedConversationResult {
  name: string | null;
  status: "completed" | "error";
  caller_prompt: string;
  duration_ms: number;
  error: string | null;
  transcript: FormattedTranscriptTurn[];
  latency: FormattedLatency | null;
  behavior: FormattedBehavior | null;
  transcript_quality: TranscriptMetrics | null;
  audio_analysis: FormattedAudioAnalysis | null;
  tool_calls: FormattedToolCalls;
  warnings: string[];
  audio_actions: AudioActionResult[];
  emotion: FormattedEmotion | null;
}

// ---- Public API ----

export function formatConversationResult(raw: unknown): FormattedConversationResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as ConversationTestResult;
  if (typeof r.caller_prompt !== "string") return null;

  return {
    name: r.name ?? null,
    status: r.status,
    caller_prompt: r.caller_prompt,
    duration_ms: r.duration_ms,
    error: r.error ?? null,
    transcript: formatTranscript(r.transcript),
    latency: r.metrics?.latency ? formatLatency(r.metrics.latency, r.metrics) : null,
    behavior: r.metrics?.behavioral ? formatBehavior(r.metrics.behavioral) : null,
    transcript_quality: r.metrics?.transcript && hasContent(r.metrics.transcript) ? r.metrics.transcript : null,
    audio_analysis: r.metrics?.audio_analysis ? formatAudioAnalysis(r.metrics.audio_analysis) : null,
    tool_calls: formatToolCalls(r.metrics?.tool_calls, r.observed_tool_calls),
    warnings: [
      ...(r.metrics?.audio_analysis_warnings ?? []).map(w => w.message),
      ...(r.metrics?.prosody_warnings ?? []).map(w => w.message),
    ],
    audio_actions: r.audio_action_results ?? [],
    emotion: r.metrics?.prosody ? formatEmotion(r.metrics.prosody) : null,
  };
}

// ---- Helpers ----


function formatTranscript(turns: ConversationTurn[] | undefined): FormattedTranscriptTurn[] {
  if (!turns) return [];
  return turns.map((t) => {
    const turn: FormattedTranscriptTurn = {
      role: t.role,
      text: t.text,
    };
    // Include timing/quality fields when present (strip tts_ms, stt_ms, timestamp_ms)
    if (t.ttfb_ms != null) turn.ttfb_ms = t.ttfb_ms;
    if (t.ttfw_ms != null) turn.ttfw_ms = t.ttfw_ms;
    if (t.stt_confidence != null) turn.stt_confidence = t.stt_confidence;
    if (t.audio_duration_ms != null) turn.audio_duration_ms = t.audio_duration_ms;
    if (t.silence_pad_ms != null) turn.silence_pad_ms = t.silence_pad_ms;
    return turn;
  });
}

function formatLatency(latency: LatencyMetrics, metrics: ConversationTestResult["metrics"]): FormattedLatency | null {
  if (metrics.mean_ttfw_ms == null || latency.p50_ttfw_ms == null || latency.p95_ttfw_ms == null) return null;

  const result: FormattedLatency = {
    mean_ttfw_ms: metrics.mean_ttfw_ms,
    p50_ttfw_ms: latency.p50_ttfw_ms,
    p95_ttfw_ms: latency.p95_ttfw_ms,
    p99_ttfw_ms: latency.p99_ttfw_ms ?? latency.p99_ttfb_ms,
    first_turn_ttfw_ms: latency.first_turn_ttfw_ms ?? latency.first_turn_ttfb_ms,
    total_silence_ms: latency.total_silence_ms,
    mean_turn_gap_ms: latency.mean_turn_gap_ms,
    ttfw_per_turn_ms: latency.ttfw_per_turn_ms ?? latency.ttfb_per_turn_ms,
  };

  if (latency.drift_slope_ms_per_turn != null) result.drift_slope_ms_per_turn = latency.drift_slope_ms_per_turn;
  if (latency.mean_silence_pad_ms != null) result.mean_silence_pad_ms = latency.mean_silence_pad_ms;
  if (latency.mouth_to_ear_est_ms != null) result.mouth_to_ear_est_ms = latency.mouth_to_ear_est_ms;

  return result;
}

function formatAudioAnalysis(audio: AudioAnalysisMetrics): FormattedAudioAnalysis {
  return {
    agent_speech_ratio: audio.agent_speech_ratio,
    talk_ratio_vad: audio.talk_ratio_vad,
    longest_monologue_ms: audio.longest_monologue_ms,
    silence_gaps_over_2s: audio.silence_gaps_over_2s,
    total_internal_silence_ms: audio.total_internal_silence_ms,
    mean_agent_speech_segment_ms: audio.mean_agent_speech_segment_ms,
  };
}

function formatToolCalls(
  summary: ToolCallMetrics | undefined,
  observed: ObservedToolCall[] | undefined,
): FormattedToolCalls {
  return {
    total: summary?.total ?? observed?.length ?? 0,
    successful: summary?.successful ?? observed?.filter((c) => c.successful).length ?? 0,
    failed: summary?.failed ?? observed?.filter((c) => c.successful === false).length ?? 0,
    mean_latency_ms: summary?.mean_latency_ms,
    names: summary?.names ?? [...new Set((observed ?? []).map((c) => c.name))],
    observed: (observed ?? []).map((c) => ({
      name: c.name,
      arguments: c.arguments,
      result: c.result,
      successful: c.successful,
      latency_ms: c.latency_ms,
      turn_index: c.turn_index,
    })),
  };
}

function formatBehavior(b: BehavioralMetrics): FormattedBehavior | null {
  const result: FormattedBehavior = {};

  if (b.intent_accuracy) result.intent_accuracy = b.intent_accuracy;
  if (b.context_retention) result.context_retention = b.context_retention;
  if (b.topic_drift) result.topic_drift = b.topic_drift;
  if (b.empathy_score) result.empathy_score = b.empathy_score;
  if (b.hallucination_detected) result.hallucination_detected = b.hallucination_detected;

  // Merge compliance_adherence score into safety_compliance
  if (b.safety_compliance || b.compliance_adherence) {
    result.safety_compliance = {
      compliant: b.safety_compliance?.compliant ?? true,
      score: b.compliance_adherence?.score,
      reasoning: b.safety_compliance?.reasoning ?? b.compliance_adherence?.reasoning ?? "",
    };
  }

  if (b.escalation_handling) result.escalation_handling = b.escalation_handling;

  return hasContent(result) ? result : null;
}

function formatEmotion(prosody: ProsodyMetrics): FormattedEmotion {
  return {
    mean_calmness: prosody.mean_calmness,
    mean_confidence: prosody.mean_confidence,
    peak_frustration: prosody.peak_frustration,
    emotion_consistency: prosody.emotion_consistency,
    naturalness: prosody.naturalness,
    emotion_trajectory: prosody.emotion_trajectory,
    per_turn: prosody.per_turn,
  };
}

function hasContent(obj: object): boolean {
  return Object.values(obj).some((v) => v != null);
}

// ---- Load test formatting ----

interface FormattedLoadTestTier {
  concurrency: number;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  error_rate: number;
  ttfw_p50_ms: number;
  ttfw_p95_ms: number;
  ttfw_p99_ms: number;
  ttfb_degradation_pct: number;
  duration_ms: number;
}

interface FormattedLoadTestSoak extends FormattedLoadTestTier {
  latency_drift_slope: number;
  degraded: boolean;
}

export interface FormattedLoadTestResult {
  status: "pass" | "fail";
  severity: LoadTestSeverity;
  target_concurrency: number;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  duration_ms: number;
  tiers: FormattedLoadTestTier[];
  spike?: FormattedLoadTestTier;
  soak?: FormattedLoadTestSoak;
  breaking_point?: LoadTestBreakingPoint;
  grading: LoadTestGrading;
}

export function formatLoadTestResult(raw: unknown): FormattedLoadTestResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as LoadTestResult;
  if (typeof r.status !== "string") return null;

  // Filter tiers to ramp-only (spike/soak live at top level)
  const rampTiers = r.tiers.filter(t => !t.phase || t.phase === "ramp");

  return {
    status: r.status,
    severity: r.severity,
    target_concurrency: r.target_concurrency,
    total_calls: r.total_calls,
    successful_calls: r.successful_calls,
    failed_calls: r.failed_calls,
    duration_ms: r.duration_ms,
    tiers: rampTiers.map(formatTier),
    spike: r.spike ? formatTier(r.spike) : undefined,
    soak: r.soak ? formatSoakTier(r.soak) : undefined,
    breaking_point: r.breaking_point,
    grading: r.grading,
  };
}

function formatTier(t: LoadTestTierResult): FormattedLoadTestTier {
  return {
    concurrency: t.concurrency,
    total_calls: t.total_calls,
    successful_calls: t.successful_calls,
    failed_calls: t.failed_calls,
    error_rate: t.error_rate,
    ttfw_p50_ms: t.ttfw_p50_ms,
    ttfw_p95_ms: t.ttfw_p95_ms,
    ttfw_p99_ms: t.ttfw_p99_ms,
    ttfb_degradation_pct: t.ttfb_degradation_pct,
    duration_ms: t.duration_ms,
  };
}

function formatSoakTier(t: LoadTestTierResult): FormattedLoadTestSoak {
  return {
    ...formatTier(t),
    latency_drift_slope: t.latency_drift_slope ?? 0,
    degraded: t.degraded ?? false,
  };
}
