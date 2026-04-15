/**
 * Transforms raw ConversationCallResult into a structured, grouped format
 * for agent consumption (CLI).
 *
 * Groups metrics by concern and removes Vent internals by default. Verbose mode
 * re-attaches debug-only details such as harness timings, raw warnings, and
 * provider artifacts.
 */

import type {
  ConversationCallResult,
  ConversationTurn,
  ObservedToolCall,
  AudioActionResult,
  LatencyMetrics,
  AudioAnalysisMetrics,
  ProsodyMetrics,
  ToolCallMetrics,
  CallMetadata,
  CallTransfer,
  CostBreakdown,
  UsageEntry,
  ComponentLatencyMetrics,
  ComponentLatency,
  HarnessOverhead,
  SignalQualityMetrics,
  ProviderWarning,
} from "./types.js";

// ---- Formatted types ----

interface FormattedTranscriptTurn {
  role: "caller" | "agent";
  text: string;
  ttfb_ms?: number;
  ttfw_ms?: number;
  audio_duration_ms?: number;
  interrupted?: boolean;
  is_interruption?: boolean;
  debug?: {
    timestamp_ms: number;
    caller_decision_mode?: ConversationTurn["caller_decision_mode"];
    silence_pad_ms?: number;
    stt_confidence?: number;
    harness_tts_ms?: number;
    harness_stt_ms?: number;
    component_latency?: ComponentLatency;
    platform_transcript?: string;
  };
}

interface FormattedLatency {
  response_time_ms: number;
  response_time_source: "ttfw" | "ttfb";
  p50_response_time_ms: number;
  p90_response_time_ms: number;
  p95_response_time_ms: number;
  p99_response_time_ms: number;
  first_response_time_ms: number;
  mean_ttfw_ms?: number;
  p50_ttfw_ms?: number;
  p90_ttfw_ms?: number;
  p95_ttfw_ms?: number;
  p99_ttfw_ms?: number;
  first_turn_ttfw_ms?: number;
  total_silence_ms: number;
  mean_turn_gap_ms: number;
  drift_slope_ms_per_turn?: number;
  mean_silence_pad_ms?: number;
  mouth_to_ear_est_ms?: number;
}

interface FormattedAudioAnalysis {
  caller_talk_time_ms: number;
  agent_talk_time_ms: number;
  agent_speech_ratio: number;
  talk_ratio_vad: number;
  interruption_rate: number;
  interruption_count: number;
  agent_overtalk_after_barge_in_ms?: number;
  agent_interrupting_user_rate: number;
  agent_interrupting_user_count: number;
  missed_response_windows: number;
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
    provider_tool_type?: string;
    latency_ms?: number;
    turn_index?: number;
  }>;
}

interface FormattedEmotion {
  naturalness: number;
  mean_calmness: number;
  mean_confidence: number;
  peak_frustration: number;
  emotion_trajectory: "stable" | "improving" | "degrading" | "volatile";
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
  provider_call_id?: string;
  provider_session_id?: string;
  ended_reason?: string;
  cost_usd?: number;
  cost_breakdown?: CostBreakdown;
  usage?: UsageEntry[];
  recording_url?: string;
  recording_variants?: Record<string, string>;
  provider_debug_urls?: Record<string, string>;
  variables?: Record<string, unknown>;
  transfer_attempted?: boolean;
  transfer_completed?: boolean;
  escalated?: boolean;
  transfer_count?: number;
  completed_transfer_count?: number;
  transfers?: CallTransfer[];
}

interface FormattedDebugToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  provider_tool_type?: string;
  timestamp_ms?: number;
  latency_ms?: number;
  turn_index?: number;
}

interface FormattedConversationDebug {
  signal_quality?: SignalQualityMetrics;
  harness_overhead?: HarnessOverhead;
  prosody?: ProsodyMetrics;
  provider_warnings?: ProviderWarning[];
  component_latency_per_turn?: ComponentLatency[];
  observed_tool_calls?: FormattedDebugToolCall[];
  provider_metadata?: Record<string, unknown>;
}

export interface FormattedConversationResult {
  name: string | null;
  status: "completed" | "error";
  caller_prompt: string;
  duration_ms: number;
  error: string | null;
  transcript: FormattedTranscriptTurn[];
  latency: FormattedLatency | null;
  audio_analysis: FormattedAudioAnalysis | null;
  tool_calls: FormattedToolCalls;
  component_latency: FormattedComponentLatency | null;
  call_metadata: FormattedCallMetadata | null;
  warnings: string[];
  audio_actions: AudioActionResult[];
  emotion: FormattedEmotion | null;
  debug?: FormattedConversationDebug;
}

export interface FormatConversationResultOptions {
  verbose?: boolean;
}

// ---- Public API ----

export function formatConversationResult(
  raw: unknown,
  options: FormatConversationResultOptions = {},
): FormattedConversationResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as ConversationCallResult;
  if (typeof r.caller_prompt !== "string") return null;

  const debug = options.verbose ? formatDebug(r) : undefined;

  return {
    name: r.name ?? null,
    status: r.status,
    caller_prompt: r.caller_prompt,
    duration_ms: r.duration_ms,
    error: r.error ?? null,
    transcript: formatTranscript(r.transcript, options),
    latency: r.metrics?.latency ? formatLatency(r.metrics.latency, r.metrics) : null,
    audio_analysis: r.metrics?.audio_analysis && hasContent(r.metrics.audio_analysis) ? formatAudioAnalysis(r.metrics.audio_analysis) : null,
    tool_calls: formatToolCalls(r.metrics?.tool_calls, r.observed_tool_calls),
    component_latency: formatComponentLatency(r.metrics?.component_latency),
    call_metadata: formatCallMetadata(r.call_metadata),
    warnings: dedupeStrings([
      ...formatProviderWarningMessages(r.call_metadata?.provider_warnings),
    ]),
    audio_actions: r.audio_action_results ?? [],
    emotion: r.metrics?.prosody ? formatEmotion(r.metrics.prosody) : null,
    ...(debug ? { debug } : {}),
  };
}

// ---- Helpers ----


function formatTranscript(
  turns: ConversationTurn[] | undefined,
  options: FormatConversationResultOptions,
): FormattedTranscriptTurn[] {
  if (!turns) return [];
  return turns.map((t) => {
    const turn: FormattedTranscriptTurn = {
      role: t.role,
      text: t.text,
    };
    // Include user-facing timing/interrupt fields when present.
    if (t.ttfb_ms != null) turn.ttfb_ms = t.ttfb_ms;
    if (t.ttfw_ms != null) turn.ttfw_ms = t.ttfw_ms;
    if (t.audio_duration_ms != null) turn.audio_duration_ms = t.audio_duration_ms;
    if (t.interrupted != null) turn.interrupted = t.interrupted;
    if (t.is_interruption != null) turn.is_interruption = t.is_interruption;
    if (options.verbose) {
      const debug = compactUnknownRecord({
        timestamp_ms: t.timestamp_ms,
        caller_decision_mode: t.caller_decision_mode,
        silence_pad_ms: t.silence_pad_ms,
        stt_confidence: t.stt_confidence,
        harness_tts_ms: t.tts_ms,
        harness_stt_ms: t.stt_ms,
        component_latency: t.component_latency,
        platform_transcript: t.platform_transcript,
      });
      if (debug && Object.keys(debug).length > 0) {
        turn.debug = debug as FormattedTranscriptTurn["debug"];
      }
    }
    return turn;
  });
}

function formatLatency(latency: LatencyMetrics, metrics: ConversationCallResult["metrics"]): FormattedLatency | null {
  const hasTtfw =
    metrics.mean_ttfw_ms != null
    && latency.p50_ttfw_ms != null
    && latency.p95_ttfw_ms != null;
  const responseTimeSource: "ttfw" | "ttfb" = hasTtfw ? "ttfw" : "ttfb";

  const result: FormattedLatency = {
    response_time_ms: hasTtfw ? metrics.mean_ttfw_ms! : metrics.mean_ttfb_ms,
    response_time_source: responseTimeSource,
    p50_response_time_ms: hasTtfw ? latency.p50_ttfw_ms! : latency.p50_ttfb_ms,
    p90_response_time_ms: hasTtfw ? (latency.p90_ttfw_ms ?? latency.p90_ttfb_ms) : latency.p90_ttfb_ms,
    p95_response_time_ms: hasTtfw ? latency.p95_ttfw_ms! : latency.p95_ttfb_ms,
    p99_response_time_ms: hasTtfw ? (latency.p99_ttfw_ms ?? latency.p99_ttfb_ms) : latency.p99_ttfb_ms,
    first_response_time_ms: hasTtfw ? (latency.first_turn_ttfw_ms ?? latency.first_turn_ttfb_ms) : latency.first_turn_ttfb_ms,
    total_silence_ms: latency.total_silence_ms,
    mean_turn_gap_ms: latency.mean_turn_gap_ms,
  };

  if (hasTtfw) {
    result.mean_ttfw_ms = metrics.mean_ttfw_ms;
    result.p50_ttfw_ms = latency.p50_ttfw_ms;
    result.p90_ttfw_ms = latency.p90_ttfw_ms ?? latency.p90_ttfb_ms;
    result.p95_ttfw_ms = latency.p95_ttfw_ms;
    result.p99_ttfw_ms = latency.p99_ttfw_ms ?? latency.p99_ttfb_ms;
    result.first_turn_ttfw_ms = latency.first_turn_ttfw_ms ?? latency.first_turn_ttfb_ms;
  }

  if (latency.drift_slope_ms_per_turn != null) result.drift_slope_ms_per_turn = latency.drift_slope_ms_per_turn;
  if (latency.mean_silence_pad_ms != null) result.mean_silence_pad_ms = latency.mean_silence_pad_ms;
  if (latency.mouth_to_ear_est_ms != null) result.mouth_to_ear_est_ms = latency.mouth_to_ear_est_ms;

  return result;
}

function formatAudioAnalysis(audio: AudioAnalysisMetrics): FormattedAudioAnalysis {
  return {
    caller_talk_time_ms: audio.caller_talk_time_ms,
    agent_talk_time_ms: audio.agent_talk_time_ms,
    agent_speech_ratio: audio.agent_speech_ratio,
    talk_ratio_vad: audio.talk_ratio_vad,
    interruption_rate: audio.interruption_rate,
    interruption_count: audio.interruption_count,
    agent_overtalk_after_barge_in_ms: audio.agent_overtalk_after_barge_in_ms,
    agent_interrupting_user_rate: audio.agent_interrupting_user_rate,
    agent_interrupting_user_count: audio.agent_interrupting_user_count,
    missed_response_windows: audio.missed_response_windows,
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
      provider_tool_type: c.provider_tool_type,
      latency_ms: c.latency_ms,
      turn_index: c.turn_index,
    })),
  };
}

function formatEmotion(prosody: ProsodyMetrics): FormattedEmotion {
  return {
    naturalness: prosody.naturalness,
    mean_calmness: prosody.mean_calmness,
    mean_confidence: prosody.mean_confidence,
    peak_frustration: prosody.peak_frustration,
    emotion_trajectory: prosody.emotion_trajectory,
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
  const transfers = meta.transfers?.map((transfer) => {
    const formattedTransfer: CallTransfer = {
      type: transfer.type,
      destination: transfer.destination,
      status: transfer.status,
      sources: transfer.sources,
    };
    if (transfer.timestamp_ms != null) {
      formattedTransfer.timestamp_ms = transfer.timestamp_ms;
    }
    return formattedTransfer;
  });

  const result: FormattedCallMetadata = {
    platform: meta.platform,
    provider_call_id: meta.provider_call_id,
    provider_session_id: meta.provider_session_id,
    ended_reason: meta.ended_reason,
    cost_usd: meta.cost_usd,
    cost_breakdown: meta.cost_breakdown,
    usage: meta.usage && meta.usage.length > 0 ? meta.usage : undefined,
    recording_url: meta.recording_url,
    recording_variants: meta.recording_variants,
    provider_debug_urls: meta.provider_debug_urls,
    variables: meta.variables,
  };

  if (transfers && transfers.length > 0) {
    const completedTransferCount = transfers.filter((transfer) => transfer.status === "completed").length;
    const transferCompleted = completedTransferCount > 0;
    result.transfer_attempted = true;
    result.transfer_completed = transferCompleted;
    result.escalated = transferCompleted;
    result.transfer_count = transfers.length;
    result.completed_transfer_count = completedTransferCount;
    result.transfers = transfers;
  }

  return result;
}

function formatDebug(result: ConversationCallResult): FormattedConversationDebug | undefined {
  const debug = compactUnknownRecord({
    signal_quality: result.metrics?.signal_quality,
    harness_overhead: result.metrics?.harness_overhead,
    prosody: result.metrics?.prosody,
    provider_warnings: nonEmptyArray(result.call_metadata?.provider_warnings),
    component_latency_per_turn: nonEmptyArray(result.metrics?.component_latency?.per_turn),
    observed_tool_calls: formatDebugToolCalls(result.observed_tool_calls),
    provider_metadata: result.call_metadata?.provider_metadata,
  });

  return debug && Object.keys(debug).length > 0
    ? debug as FormattedConversationDebug
    : undefined;
}

function formatDebugToolCalls(observed: ObservedToolCall[] | undefined): FormattedDebugToolCall[] | undefined {
  if (!observed || observed.length === 0) return undefined;
  return observed.map((call) => ({
    name: call.name,
    arguments: call.arguments,
    result: call.result,
    successful: call.successful,
    provider_tool_type: call.provider_tool_type,
    timestamp_ms: call.timestamp_ms,
    latency_ms: call.latency_ms,
    turn_index: call.turn_index,
  }));
}

function nonEmptyArray<T>(value: T[] | undefined): T[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

function formatProviderWarningMessages(warnings: ProviderWarning[] | undefined): string[] {
  if (!warnings || warnings.length === 0) return [];
  return warnings
    .map((warning) => warning.message ?? warning.code)
    .filter((message): message is string => typeof message === "string" && message.length > 0);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function compactUnknownRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function hasContent(obj: object): boolean {
  return Object.values(obj).some((v) => v != null);
}

