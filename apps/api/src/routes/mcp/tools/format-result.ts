/**
 * Transforms raw ConversationTestResult into a structured, grouped format
 * for coding agent consumption via MCP.
 *
 * Groups metrics by concern, removes VoiceCI internals (harness overhead,
 * Hume API timing, our TTS/STT processing time), and adds eval summary counts.
 */

import type {
  ConversationTestResult,
  ConversationTurn,
  EvalResult,
  ObservedToolCall,
  AudioActionResult,
  LatencyMetrics,
  HarnessOverhead,
  BehavioralMetrics,
  TranscriptMetrics,
  SignalQualityMetrics,
  AudioAnalysisMetrics,
  AudioAnalysisWarning,
  ProsodyMetrics,
  ProsodyWarning,
  ToolCallMetrics,
  TestDiagnostics,
  TurnEmotionProfile,
  SentimentTrajectoryEntry,
} from "@voiceci/shared";

// ---- Formatted types (MCP API-specific, not in shared) ----

interface FormattedEvalSection {
  passed: number;
  failed: number;
  results: Array<{ question: string; passed: boolean; reasoning: string }>;
}

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
  mean_ttfb_ms: number;
  mean_ttfw_ms?: number;
  p50_ttfb_ms: number;
  p90_ttfb_ms: number;
  p95_ttfb_ms: number;
  p99_ttfb_ms: number;
  p50_ttfw_ms?: number;
  p90_ttfw_ms?: number;
  p95_ttfw_ms?: number;
  p99_ttfw_ms?: number;
  first_turn_ttfb_ms: number;
  first_turn_ttfw_ms?: number;
  total_silence_ms: number;
  mean_turn_gap_ms: number;
  mean_silence_pad_ms?: number;
  mouth_to_ear_est_ms?: number;
  drift_slope_ms_per_turn?: number;
  ttfb_per_turn_ms: number[];
  ttfw_per_turn_ms?: number[];
}

interface FormattedAudioAnalysis {
  agent_speech_ratio: number;
  talk_ratio_vad: number;
  longest_monologue_ms: number;
  silence_gaps_over_2s: number;
  total_internal_silence_ms: number;
  per_turn_speech_segments: number[];
  per_turn_internal_silence_ms: number[];
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

interface FormattedWarning {
  metric: string;
  value: number;
  threshold: number;
  severity: "warning" | "critical";
  message: string;
}

interface FormattedLatencyBreakdown {
  /** Voice agent processing time (ms) — endpointing + STT + LLM + TTS inside the agent */
  agent_response_ms: number;
  /** Network round-trip (ms) — connection overhead */
  network_ms: number;
  /** Dead audio before speech starts (ms) — agent sends silence before speaking */
  silence_before_speech_ms: number;
  /** VoiceCI test infrastructure TTS overhead per turn (ms) — does not exist in production */
  test_overhead_tts_ms: number;
  /** VoiceCI test infrastructure STT overhead per turn (ms) — does not exist in production */
  test_overhead_stt_ms: number;
}

interface FormattedDiagnostics {
  error_origin: "platform" | "agent" | null;
  error_detail: string | null;
}

export interface FormattedConversationResult {
  name: string | null;
  status: "pass" | "fail";
  caller_prompt: string;
  duration_ms: number;
  error: string | null;
  eval: FormattedEvalSection;
  tool_call_eval?: FormattedEvalSection;
  transcript: FormattedTranscriptTurn[];
  latency?: FormattedLatency;
  behavior?: BehavioralMetrics;
  transcript_quality?: TranscriptMetrics;
  signal_quality?: SignalQualityMetrics;
  audio_analysis?: FormattedAudioAnalysis;
  tool_calls?: FormattedToolCalls;
  audio_actions?: AudioActionResult[];
  emotion?: FormattedEmotion;
  latency_breakdown?: FormattedLatencyBreakdown;
  warnings?: FormattedWarning[];
  diagnostics?: FormattedDiagnostics;
}

// ---- Public API ----

export function formatConversationResult(raw: unknown): FormattedConversationResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as ConversationTestResult;
  if (typeof r.caller_prompt !== "string") return null;

  const result: FormattedConversationResult = {
    name: r.name ?? null,
    status: r.status,
    caller_prompt: r.caller_prompt,
    duration_ms: r.duration_ms,
    error: r.error ?? null,
    eval: formatEvalSection(r.eval_results),
    transcript: formatTranscript(r.transcript),
  };

  if (r.tool_call_eval_results?.length) {
    result.tool_call_eval = formatEvalSection(r.tool_call_eval_results);
  }

  if (r.metrics?.latency) {
    result.latency = formatLatency(r.metrics.latency, r.metrics);
  }

  if (r.metrics?.behavioral && hasContent(r.metrics.behavioral)) {
    result.behavior = r.metrics.behavioral;
  }

  if (r.metrics?.transcript && hasContent(r.metrics.transcript)) {
    result.transcript_quality = r.metrics.transcript;
  }

  if (r.metrics?.signal_quality) {
    result.signal_quality = r.metrics.signal_quality;
  }

  if (r.metrics?.audio_analysis) {
    result.audio_analysis = formatAudioAnalysis(r.metrics.audio_analysis);
  }

  if (r.metrics?.tool_calls || r.observed_tool_calls?.length) {
    result.tool_calls = formatToolCalls(r.metrics?.tool_calls, r.observed_tool_calls);
  }

  if (r.audio_action_results?.length) {
    result.audio_actions = r.audio_action_results;
  }

  if (r.metrics?.prosody) {
    result.emotion = formatEmotion(r.metrics.prosody);
  }

  const warnings = consolidateWarnings(
    r.metrics?.audio_analysis_warnings,
    r.metrics?.prosody_warnings,
  );
  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  const breakdown = formatLatencyBreakdown(r.metrics, r.diagnostics);
  if (breakdown) {
    result.latency_breakdown = breakdown;
  }

  if (r.diagnostics?.error_origin || r.diagnostics?.error_detail) {
    result.diagnostics = formatDiagnostics(r.diagnostics);
  }

  return result;
}

// ---- Helpers ----

function formatEvalSection(results: EvalResult[] | undefined): FormattedEvalSection {
  const items = results ?? [];
  return {
    passed: items.filter((e) => e.passed).length,
    failed: items.filter((e) => !e.passed).length,
    results: items.map((e) => ({
      question: e.question,
      passed: e.passed,
      reasoning: e.reasoning,
    })),
  };
}

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

function formatLatency(latency: LatencyMetrics, metrics: ConversationTestResult["metrics"]): FormattedLatency {
  const result: FormattedLatency = {
    mean_ttfb_ms: metrics.mean_ttfb_ms,
    p50_ttfb_ms: latency.p50_ttfb_ms,
    p90_ttfb_ms: latency.p90_ttfb_ms,
    p95_ttfb_ms: latency.p95_ttfb_ms,
    p99_ttfb_ms: latency.p99_ttfb_ms,
    first_turn_ttfb_ms: latency.first_turn_ttfb_ms,
    total_silence_ms: latency.total_silence_ms,
    mean_turn_gap_ms: latency.mean_turn_gap_ms,
    ttfb_per_turn_ms: latency.ttfb_per_turn_ms,
  };

  if (metrics.mean_ttfw_ms != null) result.mean_ttfw_ms = metrics.mean_ttfw_ms;
  if (latency.p50_ttfw_ms != null) result.p50_ttfw_ms = latency.p50_ttfw_ms;
  if (latency.p90_ttfw_ms != null) result.p90_ttfw_ms = latency.p90_ttfw_ms;
  if (latency.p95_ttfw_ms != null) result.p95_ttfw_ms = latency.p95_ttfw_ms;
  if (latency.p99_ttfw_ms != null) result.p99_ttfw_ms = latency.p99_ttfw_ms;
  if (latency.first_turn_ttfw_ms != null) result.first_turn_ttfw_ms = latency.first_turn_ttfw_ms;
  if (latency.ttfw_per_turn_ms != null) result.ttfw_per_turn_ms = latency.ttfw_per_turn_ms;
  if (latency.mean_silence_pad_ms != null) result.mean_silence_pad_ms = latency.mean_silence_pad_ms;
  if (latency.mouth_to_ear_est_ms != null) result.mouth_to_ear_est_ms = latency.mouth_to_ear_est_ms;
  if (latency.drift_slope_ms_per_turn != null) result.drift_slope_ms_per_turn = latency.drift_slope_ms_per_turn;

  return result;
}

function formatAudioAnalysis(audio: AudioAnalysisMetrics): FormattedAudioAnalysis {
  return {
    agent_speech_ratio: audio.agent_speech_ratio,
    talk_ratio_vad: audio.talk_ratio_vad,
    longest_monologue_ms: audio.longest_monologue_ms,
    silence_gaps_over_2s: audio.silence_gaps_over_2s,
    total_internal_silence_ms: audio.total_internal_silence_ms,
    per_turn_speech_segments: audio.per_turn_speech_segments,
    per_turn_internal_silence_ms: audio.per_turn_internal_silence_ms,
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
    })),
  };
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

function consolidateWarnings(
  audioWarnings: AudioAnalysisWarning[] | undefined,
  prosodyWarnings: ProsodyWarning[] | undefined,
): FormattedWarning[] {
  const warnings: FormattedWarning[] = [];
  if (audioWarnings) {
    for (const w of audioWarnings) {
      warnings.push({
        metric: w.metric,
        value: w.value,
        threshold: w.threshold,
        severity: w.severity,
        message: w.message,
      });
    }
  }
  if (prosodyWarnings) {
    for (const w of prosodyWarnings) {
      warnings.push({
        metric: w.metric,
        value: w.value,
        threshold: w.threshold,
        severity: w.severity,
        message: w.message,
      });
    }
  }
  return warnings;
}

function formatLatencyBreakdown(
  metrics: ConversationTestResult["metrics"],
  diagnostics: TestDiagnostics | undefined,
): FormattedLatencyBreakdown | undefined {
  const harness = metrics.harness_overhead;
  const meanTtfb = metrics.mean_ttfb_ms;
  if (!harness || meanTtfb <= 0) return undefined;

  const networkRtt = diagnostics?.timing?.channel_connect_ms ?? 0;
  const agentProcessing = Math.max(0, Math.round(meanTtfb - networkRtt));
  const silencePad = metrics.latency?.mean_silence_pad_ms ?? 0;

  return {
    agent_response_ms: agentProcessing,
    network_ms: Math.round(networkRtt),
    silence_before_speech_ms: Math.round(silencePad),
    test_overhead_tts_ms: Math.round(harness.mean_tts_ms),
    test_overhead_stt_ms: Math.round(harness.mean_stt_ms),
  };
}

function formatDiagnostics(diag: TestDiagnostics): FormattedDiagnostics {
  return {
    error_origin: diag.error_origin,
    error_detail: diag.error_detail,
  };
}

function hasContent(obj: object): boolean {
  return Object.values(obj).some((v) => v != null);
}
