export type RunStatus = "queued" | "running" | "pass" | "fail";
export type SourceType = "remote" | "session";

// ============================================================
// Audio + Conversation call types
// ============================================================

export const AUDIO_CALL_NAMES = [
  "audio_quality",
  "latency",
  "echo",
] as const;

export type AudioCallName = (typeof AUDIO_CALL_NAMES)[number];

export type AdapterType = "websocket" | "livekit" | "vapi" | "retell" | "elevenlabs" | "bland";
export type TransferMode = "cold" | "warm" | "unknown";
export type CallTransferStatus = "attempted" | "completed" | "cancelled" | "failed" | "unknown";
export type CallTransferSource = "platform_event" | "platform_metadata" | "tool_call";

export interface CallerPersona {
  pace?: "slow" | "normal" | "fast";
  clarity?: "clear" | "vague" | "rambling";
  disfluencies?: boolean;
  cooperation?: "cooperative" | "reluctant" | "hostile";
  emotion?: "neutral" | "cheerful" | "confused" | "frustrated" | "skeptical" | "rushed";
  interruption_style?: "low" | "high";
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

export interface ConversationCallSpec {
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
  /** ISO 639-1 language code for multilingual calls (e.g., "es", "fr", "de"). Caller speaks this language, STT transcribes it, judge evaluates in it. */
  language?: string;
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

/** Shared fields across all platform configs */
interface BasePlatformConfig {
  /** Max concurrent calls (platform-dependent) */
  max_concurrency?: number;
}

export interface BlandPlatformConfig extends BasePlatformConfig {
  provider: "bland";
  /** Bland API key (falls back to BLAND_API_KEY env) */
  bland_api_key?: string;
  /** Bland pathway ID (falls back to BLAND_PATHWAY_ID env) */
  bland_pathway_id?: string;
  /** Task prompt — used instead of pathway_id for simple agents */
  task?: string;
  /** Tool definitions (inline objects) or tool IDs (TL-xxx strings) */
  tools?: unknown[];
  /** Voice name ("maya", "josh") or custom voice clone UUID */
  voice?: string;
  /** Model: "base" (full features), "turbo" (fastest, limited features) */
  model?: string;
  /** Opening sentence — overrides any greeting in the task/pathway */
  first_sentence?: string;
  /** If true, agent waits for callee to speak first (default: false) */
  wait_for_greeting?: boolean;
  /** Max call duration in minutes (default: 30) */
  max_duration?: number;
  /** Temperature 0-1 (default: 0.7) */
  temperature?: number;
  /** Language code e.g. "babel-en", "babel-es" */
  language?: string;
  /** How quickly agent stops speaking when interrupted, in ms (default: 500) */
  interruption_threshold?: number;
  /** When true, agent ignores user interruptions entirely */
  block_interruptions?: boolean;
  /** When true, enable Bland's noise filtering on caller audio */
  noise_cancellation?: boolean;
  /** Background audio: "office", "cafe", "restaurant", "none", or null (default phone static) */
  background_track?: string | null;
  /** Boost transcription accuracy for specific words. Supports "word:boost_factor" */
  keywords?: string[];
  /** Key-value pairs accessible as {{variable}} in agent prompts/pathways */
  request_data?: Record<string, unknown>;
  /** Pronunciation overrides */
  pronunciation_guide?: Array<{ word: string; pronunciation: string; case_sensitive?: boolean; spaced?: boolean }>;
  /** Start pathway from a specific node instead of the default */
  start_node_id?: string;
  /** Specific pathway version to test (default: production) */
  pathway_version?: number;
}

export interface LiveKitPlatformConfig extends BasePlatformConfig {
  provider: "livekit";
  /** LiveKit API key (falls back to LIVEKIT_API_KEY env) */
  livekit_api_key?: string;
  /** LiveKit API secret (falls back to LIVEKIT_API_SECRET env) */
  livekit_api_secret?: string;
  /** LiveKit server URL, e.g. wss://your-app.livekit.cloud (falls back to LIVEKIT_URL env) */
  livekit_url?: string;
  /** Explicit agent dispatch — agent_name from WorkerOptions. Omit for automatic dispatch. */
  livekit_agent_name?: string;
}

export interface VapiPlatformConfig extends BasePlatformConfig {
  provider: "vapi";
  /** Vapi API key (falls back to VAPI_API_KEY env) */
  vapi_api_key?: string;
  /** Vapi assistant ID (falls back to VAPI_ASSISTANT_ID env) */
  vapi_assistant_id?: string;
}

export interface RetellPlatformConfig extends BasePlatformConfig {
  provider: "retell";
  /** Retell API key (falls back to RETELL_API_KEY env) */
  retell_api_key?: string;
  /** Retell agent ID (falls back to RETELL_AGENT_ID env) */
  retell_agent_id?: string;
}

export interface ElevenLabsPlatformConfig extends BasePlatformConfig {
  provider: "elevenlabs";
  /** ElevenLabs API key (falls back to ELEVENLABS_API_KEY env) */
  elevenlabs_api_key?: string;
  /** ElevenLabs agent ID (falls back to ELEVENLABS_AGENT_ID env) */
  elevenlabs_agent_id?: string;
}

export type PlatformConfig =
  | BlandPlatformConfig
  | LiveKitPlatformConfig
  | VapiPlatformConfig
  | RetellPlatformConfig
  | ElevenLabsPlatformConfig;

export type PlatformProvider = PlatformConfig["provider"];

/** Safe platform config summary with provider plus non-secret fields only. */
export type PlatformSummary = Record<string, unknown> & { provider: PlatformProvider };

/** Safe metadata describing a saved platform connection. */
export interface PlatformConnectionSummary {
  id: string;
  provider: PlatformProvider;
  version: number;
  resource_label: string;
}

/** Safe run-level platform metadata persisted with the run. */
export interface RunPlatformSummary {
  platform_connection_id: string | null;
  platform_connection: PlatformConnectionSummary | null;
  platform: PlatformSummary | null;
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

export interface CallSpec {
  call: ConversationCallSpec;
}

export interface CallDiagnostics {
  /** "platform" = Vent infra issue, "agent" = user's agent issue, null = call passed */
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

export interface AudioCallResult {
  call_name: AudioCallName;
  /** "completed" = probe ran successfully, "error" = probe failed to run. NOT pass/fail. */
  status: "completed" | "error";
  metrics: Record<string, number | boolean | number[]>;
  transcriptions: Record<string, string | string[] | null>;
  duration_ms: number;
  error?: string;
  diagnostics?: CallDiagnostics;
}

export interface ConversationTurn {
  role: "caller" | "agent";
  text: string;
  timestamp_ms: number;
  /** Caller decision mode that produced this turn, or the silent wait mode that led into an agent turn. */
  caller_decision_mode?: "continue" | "wait" | "closing" | "end_now";
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
  /** Platform component latency breakdown for this turn (STT/LLM/TTS) */
  component_latency?: ComponentLatency;
  /** Platform's own STT transcript for cross-referencing with Vent's STT */
  platform_transcript?: string;
  /** True if agent was interrupted mid-sentence by the caller */
  interrupted?: boolean;
  /** True if this caller turn was a barge-in interruption */
  is_interruption?: boolean;
}

// ============================================================
// Deep metric types
// ============================================================

export interface TranscriptMetrics {
  wer?: number;
  /** Consecutive insertion/substitution runs from WER alignment (proxy for STT hallucinations). */
  hallucination_events?: HallucinationEvent[];
  repetition_score?: number;
  reprompt_count?: number;
  /** Proportion of agent turns that ask the caller to repeat/rephrase (0-1). */
  reprompt_rate?: number;
  filler_word_rate?: number;
  words_per_minute?: number;
  vocabulary_diversity?: number;
}

export interface HallucinationEvent {
  /** Number of consecutive alignment errors in this run. */
  error_count: number;
  /** Reference words Vent expected the platform to hear. */
  reference_text: string;
  /** Platform STT words observed during the same error run. */
  hypothesis_text: string;
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
  /** Total caller talk time across the call (ms). */
  caller_talk_time_ms: number;
  /** Total agent speech time across the call (ms), excluding internal silence. */
  agent_talk_time_ms: number;
  /** Agent speech time / agent total audio time (0-1). Flag if <0.5 */
  agent_speech_ratio: number;
  /** VAD-corrected talk ratio: caller_audio / (caller_audio + agent_speech). Flag if >0.7 or <0.3 */
  talk_ratio_vad: number;
  /** Caller barges in while agent speech is still active / eligible caller turns */
  interruption_rate: number;
  /** Count of caller turns that begin before the prior agent utterance fully ends */
  interruption_count: number;
  /** Mean overlap time from caller barge-in until the agent stops speaking */
  barge_in_recovery_time_ms?: number;
  /** Agent starts speaking before the caller finished / eligible agent responses */
  agent_interrupting_user_rate: number;
  /** Count of agent responses that start before the caller finished speaking */
  agent_interrupting_user_count: number;
  /** Count of slow-or-missing agent response windows after caller speech */
  missed_response_windows: number;
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

// ============================================================
// Platform component latency (from VAPI WebSocket text frames)
// ============================================================

/** Per-turn component latency breakdown from platform events */
export interface ComponentLatency {
  stt_ms?: number;
  llm_ms?: number;
  tts_ms?: number;
  speech_duration_ms?: number;
}

/** Aggregated component latency across all turns */
export interface ComponentLatencyMetrics {
  per_turn: ComponentLatency[];
  mean_stt_ms?: number;
  mean_llm_ms?: number;
  mean_tts_ms?: number;
  p95_stt_ms?: number;
  p95_llm_ms?: number;
  p95_tts_ms?: number;
  /** Which component contributes most to latency */
  bottleneck?: "stt" | "llm" | "tts";
}

// ============================================================
// Platform call metadata (from GET /call/{id})
// ============================================================

/** Per-component cost breakdown from platform API */
export interface CostBreakdown {
  stt_usd?: number;
  llm_usd?: number;
  tts_usd?: number;
  transport_usd?: number;
  /** Platform fee (e.g. VAPI's per-minute charge) */
  platform_usd?: number;
  total_usd?: number;
  llm_prompt_tokens?: number;
  llm_completion_tokens?: number;
}

/** Post-call metadata from the voice platform API */
export interface CallMetadata {
  platform: string;
  ended_reason?: string;
  duration_s?: number;
  cost_usd?: number;
  /** Per-component cost breakdown (STT/LLM/TTS/transport) */
  cost_breakdown?: CostBreakdown;
  recording_url?: string;
  /** Platform's own AI-generated call summary */
  summary?: string;
  /** Platform's own success evaluation (pass/fail or rubric) */
  success_evaluation?: string;
  /** User sentiment from platform analysis */
  user_sentiment?: string;
  /** Whether the platform judged the call as successful */
  call_successful?: boolean;
  /** Final pathway/agent variables at end of call (Bland: pathway state, Vapi: extracted data) */
  variables?: Record<string, unknown>;
  /** Call transfers that occurred during the call */
  transfers?: CallTransfer[];
}

export interface CallTransfer {
  type: string;
  destination?: string;
  status: CallTransferStatus;
  sources: CallTransferSource[];
  timestamp_ms?: number;
}

export interface ConversationMetrics {
  mean_ttfb_ms: number;
  /** Mean time to first word (VAD speech onset) across agent turns */
  mean_ttfw_ms?: number;
  transcript?: TranscriptMetrics;
  latency?: LatencyMetrics;
  tool_calls?: ToolCallMetrics;
  /** Raw audio signal quality (SNR, clipping, energy, F0) — aggregated across turns */
  signal_quality?: SignalQualityMetrics;
  audio_analysis?: AudioAnalysisMetrics;
  audio_analysis_warnings?: AudioAnalysisWarning[];
  prosody?: ProsodyMetrics;
  prosody_warnings?: ProsodyWarning[];
  harness_overhead?: HarnessOverhead;
  /** Per-component latency breakdown (STT/LLM/TTS) from platform events */
  component_latency?: ComponentLatencyMetrics;
}

export interface ConversationCallResult {
  name?: string;
  caller_prompt: string;
  status: "completed" | "error";
  transcript: ConversationTurn[];

  observed_tool_calls?: ObservedToolCall[];
  audio_action_results?: AudioActionResult[];
  duration_ms: number;
  metrics: ConversationMetrics;
  error?: string;
  /** Platform call metadata (cost, ended reason, recording, analysis) */
  call_metadata?: CallMetadata;
}

export interface RunAggregateV2 {
  conversation_calls: { total: number; passed: number; failed: number };
  total_duration_ms: number;
  total_cost_usd?: number;
}

export interface RunnerCallbackPayloadV2 {
  run_id: string;
  status: "pass" | "fail";
  conversation_result: ConversationCallResult;
  aggregate: RunAggregateV2;
  error_text?: string;
}
