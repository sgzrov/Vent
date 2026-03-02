// Dashboard types mirroring packages/shared/src/types.ts
// Keep in sync with the backend source of truth.

export type RunStatus = "queued" | "running" | "pass" | "fail";
export type SourceType = "bundle" | "remote";
export type TestType = "audio" | "conversation";
export type AudioTestName =
  | "echo"
  | "barge_in"
  | "ttfb"
  | "silence_handling"
  | "connection_stability"
  | "response_completeness";

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

export interface ConversationTestSpec {
  name?: string;
  caller_prompt: string;
  max_turns: number;
  eval: string[];
  tool_call_eval?: string[];
  silence_threshold_ms?: number;
  persona?: CallerPersona;
}

export type RedTeamAttack =
  | "prompt_injection"
  | "pii_extraction"
  | "jailbreak"
  | "social_engineering"
  | "off_topic"
  | "compliance_bypass";

export interface TestSpec {
  audio_tests?: AudioTestName[];
  conversation_tests?: ConversationTestSpec[];
  red_team?: RedTeamAttack[];
}

// --- Run-level types ---

export interface RunAggregateV2 {
  audio_tests: { total: number; passed: number; failed: number };
  conversation_tests: { total: number; passed: number; failed: number };
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
  status: "pass" | "fail";
  test_type: TestType | null;
  metrics_json: AudioTestResult | ConversationTestResult;
  trace_json: ConversationTurn[];
  created_at: string;
}

// --- Audio test types ---

export interface AudioTestResult {
  test_name: AudioTestName;
  status: "pass" | "fail";
  metrics: Record<string, number | boolean>;
  duration_ms: number;
  error?: string;
}

// --- Conversation test types ---

export interface ConversationTurn {
  role: "caller" | "agent";
  text: string;
  timestamp_ms: number;
  audio_duration_ms?: number;
  ttfb_ms?: number;
  stt_confidence?: number;
  tts_ms?: number;
  stt_ms?: number;
}

export interface EvalResult {
  question: string;
  relevant: boolean;
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
  tool_call_eval_results?: EvalResult[];
  observed_tool_calls?: ObservedToolCall[];
  duration_ms: number;
  metrics: ConversationMetrics;
}

// --- Deep metric types ---

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
}

export interface TranscriptMetrics {
  wer?: number;
  repetition_score?: number;
  reprompt_count?: number;
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

export interface HarnessOverhead {
  tts_per_turn_ms: number[];
  stt_per_turn_ms: number[];
  mean_tts_ms: number;
  mean_stt_ms: number;
}

export interface ArtifactRow {
  id: string;
  kind: string;
  key: string;
  content_type: string;
  byte_size: number;
}
