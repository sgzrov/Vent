export type RunStatus = "queued" | "running" | "pass" | "fail";
export type SourceType = "bundle" | "remote";

export interface VoiceConfig {
  tts?: { voice_id?: string; api_key_env?: string };
  stt?: { api_key_env?: string };
  silence_threshold_ms?: number;
  telephony?: {
    auth_id_env?: string;
    auth_token_env?: string;
    from_number?: string;
  };
  webrtc?: {
    livekit_url_env?: string;
    api_key_env?: string;
    api_secret_env?: string;
    room?: string;
  };
}

// ============================================================
// Audio + Conversation test types
// ============================================================

export const AUDIO_TEST_NAMES = [
  "echo",
  "barge_in",
  "ttfb",
  "silence_handling",
  "connection_stability",
  "response_completeness",
  "noise_resilience",
  "endpointing",
  "audio_quality",
] as const;

export type AudioTestName = (typeof AUDIO_TEST_NAMES)[number];

export type AdapterType = "websocket" | "sip" | "webrtc" | "vapi" | "retell" | "elevenlabs" | "bland";

export interface ConversationTestSpec {
  name?: string;
  caller_prompt: string;
  max_turns: number;
  eval: string[];
  tool_call_eval?: string[];
  silence_threshold_ms?: number;
}

// ============================================================
// Tool call types
// ============================================================

export interface ObservedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  timestamp_ms?: number;
  latency_ms?: number;
}

export interface ToolCallMetrics {
  total: number;
  successful: number;
  failed: number;
  mean_latency_ms?: number;
  names: string[];
}

export interface PlatformConfig {
  provider: "vapi" | "retell" | "elevenlabs" | "bland";
  api_key_env: string;
  agent_id?: string;
}

export interface AudioTestThresholds {
  echo?: { loop_threshold?: number };
  ttfb?: {
    p95_threshold_ms?: number;
    p95_complex_threshold_ms?: number;
    p95_ttfw_threshold_ms?: number;
  };
  barge_in?: { stop_threshold_ms?: number };
  silence_handling?: { silence_duration_ms?: number };
  response_completeness?: { min_word_count?: number };
  noise_resilience?: {
    min_pass_snr_db?: number;
    max_ttfb_degradation_ms?: number;
  };
  endpointing?: {
    pause_duration_ms?: number;
    min_pass_ratio?: number;
  };
  audio_quality?: {
    max_clipping_ratio?: number;
    min_duration_ms?: number;
    min_energy_consistency?: number;
  };
  audio_analysis_grade?: AudioAnalysisGradeThresholds;
}

export interface AudioAnalysisGradeThresholds {
  agent_speech_ratio_min?: number;
  talk_ratio_vad_max?: number;
  talk_ratio_vad_min?: number;
  longest_monologue_max_ms?: number;
  silence_gaps_over_2s_max?: number;
  mean_segment_min_ms?: number;
  mean_segment_max_ms?: number;
}

export interface AudioAnalysisWarning {
  metric: string;
  value: number;
  threshold: number;
  severity: "warning" | "critical";
  message: string;
}

export interface TestSpec {
  audio_tests?: AudioTestName[];
  conversation_tests?: ConversationTestSpec[];
}

export interface AudioTestResult {
  test_name: AudioTestName;
  status: "pass" | "fail";
  metrics: Record<string, number | boolean>;
  duration_ms: number;
  error?: string;
}

export interface ConversationTurn {
  role: "caller" | "agent";
  text: string;
  timestamp_ms: number;
  audio_duration_ms?: number;
  ttfb_ms?: number;
  stt_confidence?: number;
  /** Harness TTS synthesis time for this turn's caller audio (ms) */
  tts_ms?: number;
  /** Harness STT transcription time for this turn's agent audio (ms) */
  stt_ms?: number;
}

export interface EvalResult {
  question: string;
  relevant: boolean;
  passed: boolean;
  reasoning: string;
}

// ============================================================
// Deep metric types
// ============================================================

export interface TranscriptMetrics {
  wer?: number;
  repetition_score?: number;
  reprompt_count?: number;
  filler_word_rate?: number;
  words_per_minute?: number;
  vocabulary_diversity?: number;
}

export interface LatencyMetrics {
  ttfb_per_turn_ms: number[];
  p50_ttfb_ms: number;
  p90_ttfb_ms: number;
  p95_ttfb_ms: number;
  p99_ttfb_ms: number;
  first_turn_ttfb_ms: number;
  total_silence_ms: number;
  mean_turn_gap_ms: number;
}

export interface HarnessOverhead {
  /** Per-turn TTS synthesis time (ms) — our ElevenLabs call duration */
  tts_per_turn_ms: number[];
  /** Per-turn STT transcription time (ms) — our Deepgram call duration */
  stt_per_turn_ms: number[];
  mean_tts_ms: number;
  mean_stt_ms: number;
}

export type SentimentValue = "positive" | "neutral" | "negative";

export interface SentimentTrajectoryEntry {
  turn: number;
  role: "caller" | "agent";
  value: SentimentValue;
}

export interface BehavioralMetrics {
  // Conversational quality
  intent_accuracy?: { score: number; reasoning: string };
  context_retention?: { score: number; reasoning: string };
  clarity_score?: { score: number; reasoning: string };
  topic_drift?: { score: number; reasoning: string };
  // Sentiment & empathy
  sentiment_trajectory?: SentimentTrajectoryEntry[];
  empathy_score?: { score: number; reasoning: string };
  // Safety & compliance
  hallucination_detected?: { detected: boolean; reasoning: string };
  safety_compliance?: { compliant: boolean; reasoning: string };
  compliance_adherence?: { score: number; reasoning: string };
  escalation_handling?: { triggered: boolean; handled_appropriately: boolean; score: number; reasoning: string };
}

export interface AudioAnalysisMetrics {
  /** Agent speech time / agent total audio time (0-1). Flag if <0.5 */
  agent_speech_ratio: number;
  /** VAD-corrected talk ratio: caller_audio / (caller_audio + agent_speech). Flag if >0.7 or <0.3 */
  talk_ratio_vad: number;
  /** Longest continuous agent speech segment (ms). Flag if >30000 */
  longest_monologue_ms: number;
  /** Count of silence gaps >2s within agent responses (Hamming's SGA metric) */
  silence_gaps_over_2s: number;
  /** Total silence within agent responses, excluding between-turn gaps (ms) */
  total_internal_silence_ms: number;
  /** Number of distinct speech bursts per agent turn */
  per_turn_speech_segments: number[];
  /** Silence ms within each agent turn */
  per_turn_internal_silence_ms: number[];
  /** Average speech segment duration (ms). Very short = choppy */
  mean_agent_speech_segment_ms: number;
}

export interface ConversationMetrics {
  turns: number;
  mean_ttfb_ms: number;
  total_duration_ms: number;
  talk_ratio?: number;
  transcript?: TranscriptMetrics;
  latency?: LatencyMetrics;
  behavioral?: BehavioralMetrics;
  tool_calls?: ToolCallMetrics;
  audio_analysis?: AudioAnalysisMetrics;
  audio_analysis_warnings?: AudioAnalysisWarning[];
  harness_overhead?: HarnessOverhead;
}

export interface ConversationTestResult {
  name?: string;
  caller_prompt: string;
  status: "pass" | "fail";
  transcript: ConversationTurn[];
  eval_results: EvalResult[];
  tool_call_eval_results?: EvalResult[];
  observed_tool_calls?: ObservedToolCall[];
  duration_ms: number;
  metrics: ConversationMetrics;
  error?: string;
}

export interface RunAggregateV2 {
  audio_tests: { total: number; passed: number; failed: number };
  conversation_tests: { total: number; passed: number; failed: number };
  total_duration_ms: number;
}

export interface RunnerCallbackPayloadV2 {
  run_id: string;
  status: "pass" | "fail";
  audio_results: AudioTestResult[];
  conversation_results: ConversationTestResult[];
  aggregate: RunAggregateV2;
  error_text?: string;
}

// ============================================================
// Load testing types
// ============================================================

export type LoadPattern = "ramp" | "spike" | "sustained" | "soak";

export interface LoadTestTimepoint {
  elapsed_s: number;
  active_connections: number;
  ttfb_p50_ms: number;
  ttfb_p95_ms: number;
  ttfb_p99_ms: number;
  error_rate: number;
  errors_cumulative: number;
}

export interface LoadTestResult {
  status: "pass" | "fail";
  pattern: LoadPattern;
  target_concurrency: number;
  actual_peak_concurrency: number;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  timeline: LoadTestTimepoint[];
  summary: {
    ttfb_p50_ms: number;
    ttfb_p95_ms: number;
    ttfb_p99_ms: number;
    error_rate: number;
    breaking_point?: number;
    mean_call_duration_ms: number;
  };
  duration_ms: number;
}