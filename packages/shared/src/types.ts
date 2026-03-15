export type RunStatus = "queued" | "running" | "pass" | "fail";
export type SourceType = "bundle" | "remote" | "relay";

// ============================================================
// Audio + Conversation test types
// ============================================================

export const AUDIO_TEST_NAMES = [
  "audio_quality",
  "latency",
  "echo",
] as const;

export type AudioTestName = (typeof AUDIO_TEST_NAMES)[number];

export type AdapterType = "websocket" | "sip" | "webrtc" | "vapi" | "retell" | "elevenlabs" | "bland";

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

// ============================================================
// Caller audio effects — real-world audio condition simulation
// ============================================================

/** Resolved effects for a single call — all values are concrete. */
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

/** Pool config for load tests — values can be ranges/arrays for per-caller randomization. */
export interface CallerAudioPool {
  noise?: { type: string | string[]; snr_db: number | [number, number] };
  speed?: number | [number, number];
  speakerphone?: boolean | number;
  mic_distance?: string | string[];
  clarity?: number | [number, number];
  accent?: string | string[];
  packet_loss?: number | [number, number];
  jitter_ms?: number | [number, number];
}

// ============================================================
// Audio actions — infrastructure challenges injected into conversation turns
// ============================================================

export const AUDIO_ACTION_TYPES = [
  "interrupt",
  "silence",
  "inject_noise",
  "split_sentence",
  "noise_on_caller",
] as const;

export type AudioActionType = (typeof AUDIO_ACTION_TYPES)[number];

export interface AudioAction {
  at_turn: number;
  action: AudioActionType;
  /** What the caller says to interrupt (interrupt action) */
  prompt?: string;
  /** How long to stay silent in ms (silence action, default 8000) */
  duration_ms?: number;
  /** Noise type for inject_noise / noise_on_caller (default "babble") */
  noise_type?: "babble" | "white" | "pink";
  /** Signal-to-noise ratio in dB (default 10) */
  snr_db?: number;
  /** Split sentence config (split_sentence action) */
  split?: { part_a: string; part_b: string; pause_ms: number };
}

export interface AudioActionResult {
  at_turn: number;
  action: string;
  metrics: Record<string, number | boolean>;
  transcriptions?: Record<string, string | null>;
}

export interface ConversationTestSpec {
  name?: string;
  caller_prompt: string;
  max_turns: number;

  silence_threshold_ms?: number;
  persona?: CallerPersona;
  /** Audio actions to inject at specific turns (barge-in, silence, noise, etc.) */
  audio_actions?: AudioAction[];
  /** Opt-in: run Hume prosody analysis on agent audio (requires HUME_API_KEY) */
  prosody?: boolean;
  /** Global audio effects applied to all caller audio (speakerphone, speed, noise, accent, etc.) */
  caller_audio?: CallerAudioEffects;
  /** ISO 639-1 language code for multilingual testing (e.g., "es", "fr", "de"). Caller speaks this language, STT transcribes it, judge evaluates in it. */
  language?: string;
  /** Number of times to repeat this test for statistical confidence. Default 1. */
  repeat?: number;
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
  turn_index?: number;
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

// ============================================================
// Prosody analysis types (Hume Expression Measurement)
// ============================================================

/** Per-turn emotional profile from Hume prosody analysis */
export interface TurnEmotionProfile {
  turn_index: number;
  /** Full emotion distribution — all 48 Hume emotions with scores (0-1) */
  emotions: Record<string, number>;
  /** Composite: avg(Calmness, Contentment) */
  calmness: number;
  /** Composite: avg(Confidence, Determination) */
  confidence: number;
  /** Composite: avg(Anger, Annoyance, Contempt) */
  frustration: number;
  /** Composite: avg(Sympathy, Care) */
  warmth: number;
  /** Composite: avg(Confusion, Doubt, Anxiety) */
  uncertainty: number;
}

/** Aggregate prosody metrics for a full conversation */
export interface ProsodyMetrics {
  /** Per-turn emotional profiles (agent turns only) */
  per_turn: TurnEmotionProfile[];
  /** Mean calmness across all agent turns (0-1) */
  mean_calmness: number;
  /** Mean confidence across all agent turns (0-1) */
  mean_confidence: number;
  /** Max frustration score seen in any single turn (0-1) */
  peak_frustration: number;
  /** Std dev of dominant emotion scores — high = consistent voice (0-1) */
  emotion_consistency: number;
  /** Composite: calmness + confidence + consistency - frustration (0-1) */
  naturalness: number;
  /** Direction of emotional shift across the conversation */
  emotion_trajectory: "stable" | "improving" | "degrading" | "volatile";
  /** Hume job processing time (ms) — infrastructure overhead */
  hume_latency_ms: number;
}

/** Warning from prosody grading — informational, never affects pass/fail */
export interface ProsodyWarning {
  metric: string;
  value: number;
  threshold: number;
  severity: "warning" | "critical";
  message: string;
}

export interface LoadTestSpec {
  target_concurrency: number;
  caller_prompt: string;
  /** Array of caller prompts — one picked at random per caller. Use instead of caller_prompt. */
  caller_prompts?: string[];
  max_turns?: number;
  /** Custom ramp steps — overrides default tier computation. */
  ramps?: number[];
  thresholds?: Partial<LoadTestThresholds>;
  caller_audio?: CallerAudioPool;
  language?: string;
  /** Spike multiplier — fires spike_multiplier × target_concurrency calls at once. */
  spike_multiplier?: number;
  /** Soak duration in minutes — maintains target_concurrency active calls for this duration. */
  soak_duration_min?: number;
}

export interface TestSpec {
  conversation_tests?: ConversationTestSpec[];
  load_test?: LoadTestSpec;
}

export interface TestDiagnostics {
  /** "platform" = Vent infra issue, "agent" = user's agent issue, null = test passed */
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

export interface ChannelStats {
  bytesSent: number;
  bytesReceived: number;
  errorEvents: string[];
  connectLatencyMs: number;
}

export interface AudioTestResult {
  test_name: AudioTestName;
  /** "completed" = probe ran successfully, "error" = probe failed to run. NOT pass/fail. */
  status: "completed" | "error";
  metrics: Record<string, number | boolean | number[]>;
  transcriptions: Record<string, string | string[] | null>;
  duration_ms: number;
  error?: string;
  diagnostics?: TestDiagnostics;
}

export interface ConversationTurn {
  role: "caller" | "agent";
  text: string;
  timestamp_ms: number;
  audio_duration_ms?: number;
  ttfb_ms?: number;
  /** Time to first word — VAD-detected speech onset (ms from audio sent) */
  ttfw_ms?: number;
  /** Dead audio before speech starts: ttfw_ms - ttfb_ms */
  silence_pad_ms?: number;
  stt_confidence?: number;
  /** Harness TTS synthesis time for this turn's caller audio (ms) */
  tts_ms?: number;
  /** Harness STT transcription time for this turn's agent audio (ms) */
  stt_ms?: number;
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
  /** Time to first word (VAD speech onset) per agent turn */
  ttfw_per_turn_ms?: number[];
  p50_ttfw_ms?: number;
  p90_ttfw_ms?: number;
  p95_ttfw_ms?: number;
  p99_ttfw_ms?: number;
  first_turn_ttfw_ms?: number;
  /** Mean dead audio before speech (TTFW - TTFB) across agent turns */
  mean_silence_pad_ms?: number;
  /** Estimated mouth-to-ear latency: mean TTFW + channel connect latency */
  mouth_to_ear_est_ms?: number;
  /** TTFB drift slope — positive = degradation over turns (ms/turn) */
  drift_slope_ms_per_turn?: number;
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

export interface SignalQualityMetrics {
  /** Mean signal-to-noise ratio across turns (dB). >20 good, <10 bad */
  mean_snr_db: number;
  /** Max clipping ratio across turns (0-1). >0.01 = distortion */
  max_clipping_ratio: number;
  /** Mean energy consistency across turns (0-1). <0.5 = unstable volume */
  energy_consistency: number;
  /** Total sudden volume drops across all turns */
  sudden_drops: number;
  /** Total sudden volume spikes across all turns */
  sudden_spikes: number;
  /** All turns have clean start/end (no clicks) */
  clean_edges: boolean;
  /** Mean fundamental frequency across turns (Hz) */
  f0_hz: number;
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
  mean_ttfb_ms: number;
  /** Mean time to first word (VAD speech onset) across agent turns */
  mean_ttfw_ms?: number;
  transcript?: TranscriptMetrics;
  latency?: LatencyMetrics;
  behavioral?: BehavioralMetrics;
  tool_calls?: ToolCallMetrics;
  /** Raw audio signal quality (SNR, clipping, energy, F0) — aggregated across turns */
  signal_quality?: SignalQualityMetrics;
  audio_analysis?: AudioAnalysisMetrics;
  audio_analysis_warnings?: AudioAnalysisWarning[];
  prosody?: ProsodyMetrics;
  prosody_warnings?: ProsodyWarning[];
  harness_overhead?: HarnessOverhead;
}

export interface ConversationTestResult {
  name?: string;
  caller_prompt: string;
  status: "completed" | "error";
  transcript: ConversationTurn[];

  observed_tool_calls?: ObservedToolCall[];
  audio_action_results?: AudioActionResult[];
  duration_ms: number;
  metrics: ConversationMetrics;
  error?: string;
}

export interface RunAggregateV2 {
  conversation_tests: { total: number; passed: number; failed: number };
  load_tests?: { total: number; passed: number; failed: number };
  total_duration_ms: number;
}

export interface RunnerCallbackPayloadV2 {
  run_id: string;
  status: "pass" | "fail";
  conversation_results: ConversationTestResult[];
  aggregate: RunAggregateV2;
  error_text?: string;
}

// ============================================================
// Load testing types
// ============================================================

export type LoadTestSeverity = "excellent" | "good" | "acceptable" | "critical";
export type LoadTestPhase = "ramp" | "spike" | "soak";

export interface LoadTestThresholds {
  /** [excellent, good, acceptable] — values above acceptable = critical */
  ttfw_ms: [number, number, number];
  p95_latency_ms: [number, number, number];
  error_rate: [number, number, number];
  /** Higher = better. Values below acceptable = critical */
  quality_score: [number, number, number];
}

export const DEFAULT_LOAD_TEST_THRESHOLDS: LoadTestThresholds = {
  ttfw_ms: [300, 400, 800],
  p95_latency_ms: [2200, 2500, 3000],
  error_rate: [0.001, 0.005, 0.01],
  quality_score: [0.9, 0.8, 0.7],
};

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
  /** Phase identifier — ramp (default), spike, or soak */
  phase?: LoadTestPhase;
  /** Soak: linear regression slope of TTFB over call completion order (ms/call). Positive = degradation. */
  latency_drift_slope?: number;
  /** Soak: true if drift slope is significantly positive or error rate trended upward */
  degraded?: boolean;
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
  /** Spike test result (if spike was configured) */
  spike?: LoadTestTierResult;
  /** Soak test result (if soak was configured) */
  soak?: LoadTestTierResult;
}