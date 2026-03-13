// Dashboard types mirroring packages/shared/src/types.ts
// Keep in sync with the backend source of truth.

export type RunStatus = "queued" | "running" | "pass" | "fail";
export type SourceType = "bundle" | "remote" | "relay";
export type TestType = "conversation" | "load_test";
export type AudioTestName =
  | "audio_quality"
  | "latency"
  | "echo";

/** Legacy test names from historical runs (pre-layered architecture). */
export type LegacyAudioTestName =
  | "barge_in"
  | "ttfb"
  | "silence_handling"
  | "connection_stability"
  | "response_completeness"
  | "noise_resilience"
  | "endpointing";

// --- Test spec types ---

export interface CallerPersona {
  pace?: "slow" | "normal" | "fast";
  clarity?: "clear" | "vague" | "rambling";
  disfluencies?: boolean;
  cooperation?: "cooperative" | "reluctant" | "hostile";
  emotion?: "neutral" | "cheerful" | "confused" | "frustrated" | "skeptical" | "rushed";
  interruption_style?: "none" | "occasional" | "frequent";
  memory?: "reliable" | "unreliable";
  intent_clarity?: "clear" | "indirect" | "vague";
  confirmation_style?: "explicit" | "vague";
}

export interface CallerAudioEffects {
  noise?: { type: "babble" | "white" | "pink"; snr_db: number };
  speed?: number;
  speakerphone?: boolean;
  mic_distance?: "close" | "normal" | "far";
  clarity?: number;
  accent?: string;
  packet_loss?: number;
  jitter_ms?: number;
}

export interface SafetyThreshold {
  enabled: boolean;
  reasoning?: string;
  min_score?: number;
}

export interface SafetyThresholds {
  hallucination?: SafetyThreshold;
  safety_compliance?: SafetyThreshold;
  compliance_adherence?: SafetyThreshold;
}

export interface ConversationTestSpec {
  name?: string;
  caller_prompt: string;
  max_turns: number;
  eval: string[];

  silence_threshold_ms?: number;
  persona?: CallerPersona;
  prosody?: boolean;
  caller_audio?: CallerAudioEffects;
  safety_thresholds?: SafetyThresholds;
}

export interface TestSpec {
  conversation_tests?: ConversationTestSpec[];
  load_test?: {
    target_concurrency: number;
    caller_prompt: string;
    max_turns?: number;
    eval?: string[];
  };
}

// --- Run-level types ---

export interface RunAggregateV2 {
  conversation_tests: { total: number; passed: number; failed: number };
  load_tests?: { total: number; passed: number; failed: number };
  total_duration_ms: number;
}

export interface RunRow {
  id: string;
  status: RunStatus;
  source_type: SourceType;
  bundle_hash: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  aggregate_json: RunAggregateV2 | null;
  error_text: string | null;
  test_spec_json: TestSpec | null;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  event_type: string;
  message: string;
  metadata_json: Record<string, unknown> | null;
  created_at: string;
}

export interface RunDetail extends RunRow {
  scenarios: ScenarioResultRow[];
  artifacts: ArtifactRow[];
  events: RunEventRow[];
  is_baseline: boolean;
}

// --- Scenario result types ---

export interface ScenarioResultRow {
  id: string;
  run_id: string;
  name: string;
  status: "pass" | "fail" | "completed" | "error";
  test_type: TestType | null;
  metrics_json: AudioTestResult | ConversationTestResult | LoadTestResult;
  trace_json: ConversationTurn[];
  created_at: string;
}

// --- Audio test types ---

export interface TestDiagnostics {
  error_origin: "platform" | "agent" | null;
  error_detail: string | null;
  timing: {
    channel_connect_ms: number;
  };
  channel: {
    connected: boolean;
    error_events: string[];
    audio_bytes_sent: number;
    audio_bytes_received: number;
  };
}

export interface AudioTestResult {
  test_name: AudioTestName | LegacyAudioTestName | string;
  status: "completed" | "error";
  metrics: Record<string, number | boolean>;
  transcriptions?: Record<string, string | string[] | null>;
  duration_ms: number;
  error?: string;
  diagnostics?: TestDiagnostics;
}

/** Audio action results embedded in conversation test results. */
export interface AudioActionResult {
  at_turn: number;
  action: string;
  metrics: Record<string, number | boolean>;
  transcriptions?: Record<string, string | null>;
}

// --- Conversation test types ---

export interface ConversationTurn {
  role: "caller" | "agent";
  text: string;
  timestamp_ms: number;
  audio_duration_ms?: number;
  ttfb_ms?: number;
  ttfw_ms?: number;
  silence_pad_ms?: number;
  stt_confidence?: number;
  tts_ms?: number;
  stt_ms?: number;
}

export interface EvalResult {
  question: string;
  passed: boolean;
  reasoning: string;
}

export interface ObservedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  timestamp_ms?: number;
  latency_ms?: number;
}

export interface ConversationTestResult {
  name?: string;
  caller_prompt: string;
  status: "pass" | "fail";
  transcript: ConversationTurn[];
  eval_results: EvalResult[];

  observed_tool_calls?: ObservedToolCall[];
  audio_action_results?: AudioActionResult[];
  duration_ms: number;
  metrics: ConversationMetrics;
  diagnostics?: TestDiagnostics;
}

// --- Deep metric types ---

export interface ConversationMetrics {
  mean_ttfb_ms: number;
  mean_ttfw_ms?: number;
  transcript?: TranscriptMetrics;
  latency?: LatencyMetrics;
  behavioral?: BehavioralMetrics;
  tool_calls?: ToolCallMetrics;
  audio_analysis?: AudioAnalysisMetrics;
  audio_analysis_warnings?: AudioAnalysisWarning[];
  prosody?: ProsodyMetrics;
  prosody_warnings?: ProsodyWarning[];
  harness_overhead?: HarnessOverhead;
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
  ttfw_per_turn_ms?: number[];
  p50_ttfw_ms?: number;
  p90_ttfw_ms?: number;
  p95_ttfw_ms?: number;
  p99_ttfw_ms?: number;
  first_turn_ttfw_ms?: number;
  mean_silence_pad_ms?: number;
  mouth_to_ear_est_ms?: number;
}

export interface TranscriptMetrics {
  wer?: number;
  repetition_score?: number;
  reprompt_count?: number;
  /** Filler words per 100 words (already a percent value). */
  filler_word_rate?: number;
  words_per_minute?: number;
  vocabulary_diversity?: number;
}

export interface BehavioralMetrics {
  intent_accuracy?: { score: number; reasoning: string };
  context_retention?: { score: number; reasoning: string };
  clarity_score?: { score: number; reasoning: string };
  topic_drift?: { score: number; reasoning: string };
  sentiment_trajectory?: Array<{
    turn: number;
    role: "caller" | "agent";
    value: "positive" | "neutral" | "negative";
  }>;
  empathy_score?: { score: number; reasoning: string };
  hallucination_detected?: { detected: boolean; reasoning: string };
  safety_compliance?: { compliant: boolean; reasoning: string };
  compliance_adherence?: { score: number; reasoning: string };
  escalation_handling?: {
    triggered: boolean;
    handled_appropriately: boolean;
    score: number;
    reasoning: string;
  };
}

export interface ToolCallMetrics {
  total: number;
  successful: number;
  failed: number;
  mean_latency_ms?: number;
  names: string[];
}

export interface AudioAnalysisWarning {
  metric: string;
  message: string;
  severity: "warning" | "critical";
  value: number;
  threshold: number;
}

export interface AudioAnalysisMetrics {
  agent_speech_ratio: number;
  talk_ratio_vad: number;
  longest_monologue_ms: number;
  silence_gaps_over_2s: number;
  total_internal_silence_ms: number;
  per_turn_speech_segments: number[];
  per_turn_internal_silence_ms: number[];
  mean_agent_speech_segment_ms: number;
}

export interface TurnEmotionProfile {
  turn_index: number;
  emotions: Record<string, number>;
  calmness: number;
  confidence: number;
  frustration: number;
  warmth: number;
  uncertainty: number;
}

export interface ProsodyMetrics {
  per_turn: TurnEmotionProfile[];
  mean_calmness: number;
  mean_confidence: number;
  peak_frustration: number;
  emotion_consistency: number;
  naturalness: number;
  emotion_trajectory: "stable" | "improving" | "degrading" | "volatile";
  hume_latency_ms: number;
}

export interface ProsodyWarning {
  metric: string;
  value: number;
  threshold: number;
  severity: "warning" | "critical";
  message: string;
}

export interface HarnessOverhead {
  tts_per_turn_ms: number[];
  stt_per_turn_ms: number[];
  mean_tts_ms: number;
  mean_stt_ms: number;
}

// --- Load test types ---

export type LoadTestSeverity = "excellent" | "good" | "acceptable" | "critical";

export interface LoadTestThresholds {
  ttfw_ms: [number, number, number];
  p95_latency_ms: [number, number, number];
  error_rate: [number, number, number];
  quality_score: [number, number, number];
}

export interface LoadTestBreakingPoint {
  concurrency: number;
  triggered_by: Array<"error_rate" | "p95_latency" | "quality_drop">;
  error_rate: number;
  p95_ttfb_ms: number;
  quality_score?: number;
}

export interface LoadTestGrading {
  ttfw: LoadTestSeverity;
  p95_latency: LoadTestSeverity;
  error_rate: LoadTestSeverity;
  quality: LoadTestSeverity;
  overall: LoadTestSeverity;
}

export interface LoadTestEvalSummary {
  total_evaluated: number;
  mean_quality_score: number;
  questions: Array<{ question: string; pass_rate: number }>;
}

export interface LoadTestTierResult {
  concurrency: number;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  error_rate: number;
  ttfb_p50_ms: number;
  ttfb_p95_ms: number;
  ttfb_p99_ms: number;
  ttfw_p50_ms: number;
  ttfw_p95_ms: number;
  ttfw_p99_ms: number;
  connect_p50_ms: number;
  mean_quality_score: number;
  quality_degradation_pct: number;
  ttfb_degradation_pct: number;
  duration_ms: number;
}

export interface LoadTestResult {
  status: "pass" | "fail";
  severity: LoadTestSeverity;
  target_concurrency: number;
  tiers: LoadTestTierResult[];
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  breaking_point?: LoadTestBreakingPoint;
  grading: LoadTestGrading;
  eval_summary?: LoadTestEvalSummary;
  thresholds: LoadTestThresholds;
  duration_ms: number;
}

// --- Artifact types ---

export interface ArtifactRow {
  id: string;
  kind: string;
  key: string;
  content_type: string;
  byte_size: number;
}
