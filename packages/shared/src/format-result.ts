/**
 * Transforms raw ConversationTestResult into a structured, grouped format
 * for agent consumption (CLI).
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
  LoadTestResult,
  LoadTestTierResult,
  LoadTestSeverity,
  LoadTestBreakingPoint,
  LoadTestGrading,
  CallMetadata,
  CostBreakdown,
  ComponentLatencyMetrics,
} from "./types.js";

// ---- Formatted types ----

interface FormattedTranscriptTurn {
  role: "caller" | "agent";
  text: string;
  ttfb_ms?: number;
  ttfw_ms?: number;
  stt_confidence?: number;
  audio_duration_ms?: number;
  silence_pad_ms?: number;
  component_latency?: { stt_ms?: number; llm_ms?: number; tts_ms?: number; speech_duration_ms?: number };
  platform_transcript?: string;
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
  emotion_trajectory: "stable" | "improving" | "degrading" | "volatile";
  peak_frustration: number;
}

interface FormattedBehavior {
  intent_accuracy?: { score: number; reasoning: string };
  context_retention?: { score: number; reasoning: string };
  hallucination_detected?: { detected: boolean; reasoning: string };
  safety_compliance?: { compliant: boolean; score?: number; reasoning: string };
  escalation_handling?: { triggered: boolean; handled_appropriately: boolean; score: number; reasoning: string };
}

interface FormattedComponentLatency {
  mean_stt_ms?: number;
  mean_llm_ms?: number;
  mean_tts_ms?: number;
  p95_stt_ms?: number;
  p95_llm_ms?: number;
  p95_tts_ms?: number;
  mean_speech_duration_ms?: number;
  bottleneck?: "stt" | "llm" | "tts";
}

interface FormattedCallMetadata {
  platform: string;
  ended_reason?: string;
  cost_usd?: number;
  cost_breakdown?: CostBreakdown;
  recording_url?: string;
  summary?: string;
  success_evaluation?: string;
  user_sentiment?: string;
  call_successful?: boolean;
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
  transcript_quality: Partial<TranscriptMetrics> | null;
  audio_analysis: FormattedAudioAnalysis | null;
  tool_calls: FormattedToolCalls;
  component_latency: FormattedComponentLatency | null;
  call_metadata: FormattedCallMetadata | null;
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
    transcript_quality: r.metrics?.transcript && hasContent(r.metrics.transcript) ? filterTranscriptMetrics(r.metrics.transcript) : null,
    audio_analysis: r.metrics?.audio_analysis ? formatAudioAnalysis(r.metrics.audio_analysis) : null,
    tool_calls: formatToolCalls(r.metrics?.tool_calls, r.observed_tool_calls),
    component_latency: formatComponentLatency(r.metrics?.component_latency),
    call_metadata: formatCallMetadata(r.call_metadata),
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
    if (t.component_latency) turn.component_latency = t.component_latency;
    if (t.platform_transcript) turn.platform_transcript = t.platform_transcript;
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

function filterTranscriptMetrics(t: TranscriptMetrics): Partial<TranscriptMetrics> {
  const { vocabulary_diversity, filler_word_rate, words_per_minute, ...kept } = t;
  return kept;
}

function formatEmotion(prosody: ProsodyMetrics): FormattedEmotion {
  return {
    emotion_trajectory: prosody.emotion_trajectory,
    peak_frustration: prosody.peak_frustration,
  };
}

function formatComponentLatency(cl: ComponentLatencyMetrics | undefined): FormattedComponentLatency | null {
  if (!cl) return null;
  const speechDurations = cl.per_turn
    .map((t) => t.speech_duration_ms)
    .filter((v): v is number => v != null);
  const meanSpeech = speechDurations.length > 0
    ? Math.round(speechDurations.reduce((a, b) => a + b, 0) / speechDurations.length)
    : undefined;
  return {
    mean_stt_ms: cl.mean_stt_ms,
    mean_llm_ms: cl.mean_llm_ms,
    mean_tts_ms: cl.mean_tts_ms,
    p95_stt_ms: cl.p95_stt_ms,
    p95_llm_ms: cl.p95_llm_ms,
    p95_tts_ms: cl.p95_tts_ms,
    mean_speech_duration_ms: meanSpeech,
    bottleneck: cl.bottleneck,
  };
}

function formatCallMetadata(meta: CallMetadata | undefined): FormattedCallMetadata | null {
  if (!meta) return null;
  return {
    platform: meta.platform,
    ended_reason: meta.ended_reason,
    cost_usd: meta.cost_usd,
    cost_breakdown: meta.cost_breakdown,
    recording_url: meta.recording_url,
    summary: meta.summary,
    success_evaluation: meta.success_evaluation,
    user_sentiment: meta.user_sentiment,
    call_successful: meta.call_successful,
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
