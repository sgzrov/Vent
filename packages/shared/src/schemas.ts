import { z } from "zod";
import { AUDIO_TEST_NAMES, AUDIO_ACTION_TYPES } from "./types.js";

// ============================================================
// V2 Schemas — Dynamic voice agent testing
// ============================================================

export const AudioTestNameSchema = z.enum(AUDIO_TEST_NAMES);

export const AudioActionSchema = z.object({
  at_turn: z.number().int().min(0),
  action: z.enum(AUDIO_ACTION_TYPES),
  prompt: z.string().optional(),
  duration_ms: z.number().int().min(1000).max(30000).optional(),
  noise_type: z.enum(["babble", "white", "pink"]).optional(),
  snr_db: z.number().min(0).max(40).optional(),
  split: z.object({
    part_a: z.string().min(1),
    part_b: z.string().min(1),
    pause_ms: z.number().int().min(500).max(5000),
  }).optional(),
});

export const AudioActionResultSchema = z.object({
  at_turn: z.number().int().min(0),
  action: z.string(),
  metrics: z.record(z.union([z.number(), z.boolean()])),
  transcriptions: z.record(z.union([z.string(), z.null()])).optional(),
});

export const CallerPersonaSchema = z.object({
  pace: z.enum(["slow", "normal", "fast"]).optional(),
  clarity: z.enum(["clear", "vague", "rambling"]).optional(),
  disfluencies: z.boolean().optional(),
  cooperation: z.enum(["cooperative", "reluctant", "hostile"]).optional(),
  emotion: z.enum(["neutral", "cheerful", "confused", "frustrated", "skeptical", "rushed"]).optional(),
  interruption_style: z.enum(["none", "occasional", "frequent"]).optional(),
  memory: z.enum(["reliable", "unreliable"]).optional(),
  intent_clarity: z.enum(["clear", "indirect", "vague"]).optional(),
  confirmation_style: z.enum(["explicit", "vague"]).optional(),
}).optional();

export const CallerAudioEffectsSchema = z.object({
  noise: z.object({
    type: z.enum(["babble", "white", "pink"]),
    snr_db: z.number().min(0).max(40).default(10),
  }).optional(),
  speed: z.number().min(0.5).max(2.0).optional(),
  speakerphone: z.boolean().optional(),
  mic_distance: z.enum(["close", "normal", "far"]).optional(),
  clarity: z.number().min(0).max(1).optional(),
  accent: z.string().optional(),
  packet_loss: z.number().min(0).max(0.3).optional(),
  jitter_ms: z.number().min(0).max(100).optional(),
});

const noiseTypeEnum = z.enum(["babble", "white", "pink"]);
const micDistanceEnum = z.enum(["close", "normal", "far"]);

export const CallerAudioPoolSchema = z.object({
  noise: z.object({
    type: z.union([noiseTypeEnum, z.array(noiseTypeEnum)]),
    snr_db: z.union([z.number(), z.tuple([z.number(), z.number()])]),
  }).optional(),
  speed: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
  speakerphone: z.union([z.boolean(), z.number().min(0).max(1)]).optional(),
  mic_distance: z.union([micDistanceEnum, z.array(micDistanceEnum)]).optional(),
  clarity: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
  accent: z.union([z.string(), z.array(z.string())]).optional(),
  packet_loss: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
  jitter_ms: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
});

export const ConversationTestSpecSchema = z.object({
  name: z.string().optional(),
  caller_prompt: z.string().min(1),
  max_turns: z.number().int().min(1).max(50).default(6),

  silence_threshold_ms: z.number().int().min(200).max(10000).optional(),
  persona: CallerPersonaSchema,
  audio_actions: z.array(AudioActionSchema).optional(),
  prosody: z.boolean().optional(),
  caller_audio: CallerAudioEffectsSchema.optional(),
  /** ISO 639-1 language code for multilingual testing (e.g., "es", "fr", "de"). Caller speaks this language, STT transcribes it, judge evaluates in it. */
  language: z.string().min(2).max(5).optional(),
  /** Number of times to repeat this test for statistical confidence (1-10). Default 1. */
  repeat: z.number().int().min(1).max(10).default(1),
});

// TestSpecSchema uses z.lazy for load_test to avoid forward-reference to LoadTestSpecSchema
export const TestSpecSchema = z
  .object({
    conversation_tests: z.array(ConversationTestSpecSchema).optional(),
    red_team_tests: z.array(ConversationTestSpecSchema).optional(),
    load_test: z.lazy(() => LoadTestSpecSchema).optional(),
  })
  .refine(
    (d) => {
      const hasConv = (d.conversation_tests?.length ?? 0) > 0;
      const hasRedTeam = (d.red_team_tests?.length ?? 0) > 0;
      const hasLoad = d.load_test != null;
      return hasConv || hasRedTeam || hasLoad;
    },
    { message: "Exactly one of conversation_tests, red_team_tests, or load_test is required" }
  )
  .refine(
    (d) => {
      const hasConv = (d.conversation_tests?.length ?? 0) > 0;
      const hasRedTeam = (d.red_team_tests?.length ?? 0) > 0;
      const hasLoad = d.load_test != null;
      // Only one type per run
      const count = [hasConv, hasRedTeam, hasLoad].filter(Boolean).length;
      return count === 1;
    },
    { message: "Only one of conversation_tests, red_team_tests, or load_test can be used per run" }
  );

export const AdapterTypeSchema = z.enum(["websocket", "sip", "webrtc", "vapi", "retell", "elevenlabs", "bland"]);

// ============================================================
// Tool call schemas
// ============================================================

export const ObservedToolCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()),
  result: z.unknown().optional(),
  successful: z.boolean().optional(),
  timestamp_ms: z.number().optional(),
  latency_ms: z.number().optional(),
  turn_index: z.number().int().min(0).optional(),
});

export const ToolCallMetricsSchema = z.object({
  total: z.number().int().min(0),
  successful: z.number().int().min(0),
  failed: z.number().int().min(0),
  mean_latency_ms: z.number().optional(),
  names: z.array(z.string()),
});

export const PlatformConfigSchema = z.object({
  provider: z.enum(["vapi", "retell", "elevenlabs", "bland"]),
  api_key_env: z.string(),
  agent_id: z.string().optional(),
});

export const AudioAnalysisGradeThresholdsSchema = z.object({
  agent_speech_ratio_min: z.number().min(0).max(1).optional(),
  talk_ratio_vad_max: z.number().min(0).max(1).optional(),
  talk_ratio_vad_min: z.number().min(0).max(1).optional(),
  longest_monologue_max_ms: z.number().min(1000).optional(),
  silence_gaps_over_2s_max: z.number().int().min(0).optional(),
  mean_segment_min_ms: z.number().min(0).optional(),
  mean_segment_max_ms: z.number().min(0).optional(),
}).optional();

export const AudioAnalysisWarningSchema = z.object({
  metric: z.string(),
  value: z.number(),
  threshold: z.number(),
  severity: z.enum(["warning", "critical"]),
  message: z.string(),
});


export const TestDiagnosticsSchema = z.object({
  error_origin: z.enum(["platform", "agent"]).nullable(),
  error_detail: z.string().nullable(),
  timing: z.object({
    channel_connect_ms: z.number(),
  }),
  channel: z.object({
    connected: z.boolean(),
    error_events: z.array(z.string()),
    audio_bytes_sent: z.number(),
    audio_bytes_received: z.number(),
  }),
});

export const ConversationTurnSchema = z.object({
  role: z.enum(["caller", "agent"]),
  text: z.string(),
  timestamp_ms: z.number(),
  audio_duration_ms: z.number().optional(),
  ttfb_ms: z.number().optional(),
  ttfw_ms: z.number().optional(),
  silence_pad_ms: z.number().optional(),
  stt_confidence: z.number().optional(),
  tts_ms: z.number().optional(),
  stt_ms: z.number().optional(),
  component_latency: z.object({
    stt_ms: z.number().optional(),
    llm_ms: z.number().optional(),
    tts_ms: z.number().optional(),
  }).optional(),
  platform_transcript: z.string().optional(),
});

// ============================================================
// Deep metric schemas
// ============================================================

export const TranscriptMetricsSchema = z.object({
  wer: z.number().min(0).max(1).optional(),
  repetition_score: z.number().min(0).max(1).optional(),
  reprompt_count: z.number().int().min(0).optional(),
  filler_word_rate: z.number().min(0).optional(),
  words_per_minute: z.number().min(0).optional(),
  vocabulary_diversity: z.number().min(0).max(1).optional(),
});

export const LatencyMetricsSchema = z.object({
  ttfb_per_turn_ms: z.array(z.number()),
  p50_ttfb_ms: z.number(),
  p90_ttfb_ms: z.number(),
  p95_ttfb_ms: z.number(),
  p99_ttfb_ms: z.number(),
  first_turn_ttfb_ms: z.number(),
  total_silence_ms: z.number(),
  mean_turn_gap_ms: z.number(),
  ttfw_per_turn_ms: z.array(z.number()).optional(),
  p50_ttfw_ms: z.number().optional(),
  p90_ttfw_ms: z.number().optional(),
  p95_ttfw_ms: z.number().optional(),
  p99_ttfw_ms: z.number().optional(),
  first_turn_ttfw_ms: z.number().optional(),
  mean_silence_pad_ms: z.number().optional(),
  mouth_to_ear_est_ms: z.number().optional(),
  drift_slope_ms_per_turn: z.number().optional(),
});

const SentimentValueSchema = z.enum(["positive", "neutral", "negative"]);
const SentimentTrajectoryEntrySchema = z.object({
  turn: z.number().int().min(0),
  role: z.enum(["caller", "agent"]),
  value: SentimentValueSchema,
});

export const BehavioralMetricsSchema = z.object({
  intent_accuracy: z.object({ score: z.number(), reasoning: z.string() }).optional(),
  hallucination_detected: z.object({ detected: z.boolean(), reasoning: z.string() }).optional(),
  sentiment_trajectory: z.array(SentimentTrajectoryEntrySchema).optional(),
  context_retention: z.object({ score: z.number(), reasoning: z.string() }).optional(),
  topic_drift: z.object({ score: z.number(), reasoning: z.string() }).optional(),
  empathy_score: z.object({ score: z.number(), reasoning: z.string() }).optional(),
  clarity_score: z.object({ score: z.number(), reasoning: z.string() }).optional(),
  safety_compliance: z.object({ compliant: z.boolean(), reasoning: z.string() }).optional(),
  compliance_adherence: z.object({ score: z.number(), reasoning: z.string() }).optional(),
  escalation_handling: z
    .object({
      triggered: z.boolean(),
      handled_appropriately: z.boolean(),
      score: z.number(),
      reasoning: z.string(),
    })
    .optional(),
});

export const AudioAnalysisMetricsSchema = z.object({
  agent_speech_ratio: z.number(),
  talk_ratio_vad: z.number(),
  longest_monologue_ms: z.number(),
  silence_gaps_over_2s: z.number().int().min(0),
  total_internal_silence_ms: z.number(),
  per_turn_speech_segments: z.array(z.number().int().min(0)),
  per_turn_internal_silence_ms: z.array(z.number().int().min(0)),
  mean_agent_speech_segment_ms: z.number(),
});

export const TurnEmotionProfileSchema = z.object({
  turn_index: z.number().int().min(0),
  emotions: z.record(z.string(), z.number()),
  calmness: z.number(),
  confidence: z.number(),
  frustration: z.number(),
  warmth: z.number(),
  uncertainty: z.number(),
});

export const ProsodyMetricsSchema = z.object({
  per_turn: z.array(TurnEmotionProfileSchema),
  mean_calmness: z.number(),
  mean_confidence: z.number(),
  peak_frustration: z.number(),
  emotion_consistency: z.number(),
  naturalness: z.number(),
  emotion_trajectory: z.enum(["stable", "improving", "degrading", "volatile"]),
  hume_latency_ms: z.number(),
});

export const ProsodyWarningSchema = z.object({
  metric: z.string(),
  value: z.number(),
  threshold: z.number(),
  severity: z.enum(["warning", "critical"]),
  message: z.string(),
});

export const HarnessOverheadSchema = z.object({
  tts_per_turn_ms: z.array(z.number()),
  stt_per_turn_ms: z.array(z.number()),
  mean_tts_ms: z.number(),
  mean_stt_ms: z.number(),
});

export const SignalQualityMetricsSchema = z.object({
  mean_snr_db: z.number(),
  max_clipping_ratio: z.number(),
  energy_consistency: z.number(),
  sudden_drops: z.number().int().min(0),
  sudden_spikes: z.number().int().min(0),
  clean_edges: z.boolean(),
  f0_hz: z.number(),
});

export const ComponentLatencySchema = z.object({
  stt_ms: z.number().optional(),
  llm_ms: z.number().optional(),
  tts_ms: z.number().optional(),
  speech_duration_ms: z.number().optional(),
});

export const ComponentLatencyMetricsSchema = z.object({
  per_turn: z.array(ComponentLatencySchema),
  mean_stt_ms: z.number().optional(),
  mean_llm_ms: z.number().optional(),
  mean_tts_ms: z.number().optional(),
  p95_stt_ms: z.number().optional(),
  p95_llm_ms: z.number().optional(),
  p95_tts_ms: z.number().optional(),
  bottleneck: z.enum(["stt", "llm", "tts"]).optional(),
});

export const CostBreakdownSchema = z.object({
  stt_usd: z.number().optional(),
  llm_usd: z.number().optional(),
  tts_usd: z.number().optional(),
  transport_usd: z.number().optional(),
  platform_usd: z.number().optional(),
  total_usd: z.number().optional(),
  llm_prompt_tokens: z.number().int().optional(),
  llm_completion_tokens: z.number().int().optional(),
});

export const CallMetadataSchema = z.object({
  platform: z.string(),
  ended_reason: z.string().optional(),
  duration_s: z.number().optional(),
  cost_usd: z.number().optional(),
  cost_breakdown: CostBreakdownSchema.optional(),
  recording_url: z.string().optional(),
  summary: z.string().optional(),
  success_evaluation: z.string().optional(),
  user_sentiment: z.string().optional(),
  call_successful: z.boolean().optional(),
});

export const ConversationMetricsSchema = z.object({
  mean_ttfb_ms: z.number(),
  mean_ttfw_ms: z.number().optional(),
  transcript: TranscriptMetricsSchema.optional(),
  latency: LatencyMetricsSchema.optional(),
  behavioral: BehavioralMetricsSchema.optional(),
  tool_calls: ToolCallMetricsSchema.optional(),
  signal_quality: SignalQualityMetricsSchema.optional(),
  audio_analysis: AudioAnalysisMetricsSchema.optional(),
  audio_analysis_warnings: z.array(AudioAnalysisWarningSchema).optional(),
  prosody: ProsodyMetricsSchema.optional(),
  prosody_warnings: z.array(ProsodyWarningSchema).optional(),
  harness_overhead: HarnessOverheadSchema.optional(),
  component_latency: ComponentLatencyMetricsSchema.optional(),
});

export const AudioTestResultSchema = z.object({
  test_name: AudioTestNameSchema,
  status: z.enum(["completed", "error"]),
  metrics: z.record(z.union([z.number(), z.boolean(), z.array(z.number())])),
  transcriptions: z.record(z.union([z.string(), z.array(z.string()), z.null()])),
  duration_ms: z.number(),
  error: z.string().optional(),
  diagnostics: TestDiagnosticsSchema.optional(),
});

export const ConversationTestResultSchema = z.object({
  name: z.string().optional(),
  caller_prompt: z.string(),
  status: z.enum(["completed", "error"]),
  transcript: z.array(ConversationTurnSchema),

  observed_tool_calls: z.array(ObservedToolCallSchema).optional(),
  audio_action_results: z.array(AudioActionResultSchema).optional(),
  duration_ms: z.number(),
  metrics: ConversationMetricsSchema,
  error: z.string().optional(),
  call_metadata: CallMetadataSchema.optional(),
});

export const RunAggregateV2Schema = z.object({
  conversation_tests: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
  }).default({ total: 0, passed: 0, failed: 0 }),
  red_team_tests: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
  }).optional(),
  load_tests: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
  }).optional(),
  total_duration_ms: z.number(),
  total_cost_usd: z.number().optional(),
});

export const RunnerCallbackV2Schema = z.object({
  run_id: z.string().uuid(),
  status: z.enum(["pass", "fail"]),
  conversation_results: z.array(ConversationTestResultSchema).default([]),
  red_team_results: z.array(ConversationTestResultSchema).default([]),
  aggregate: RunAggregateV2Schema,
  error_text: z.string().optional(),
});

// ============================================================
// Load testing schemas
// ============================================================

export const LoadTestSeveritySchema = z.enum(["excellent", "good", "acceptable", "critical"]);

const ThresholdTupleSchema = z.tuple([z.number(), z.number(), z.number()]);

export const LoadTestThresholdsSchema = z.object({
  ttfw_ms: ThresholdTupleSchema,
  p95_latency_ms: ThresholdTupleSchema,
  error_rate: ThresholdTupleSchema,
  quality_score: ThresholdTupleSchema,
});

export const LoadTestSpecSchema = z.object({
  target_concurrency: z.number().int().min(1).max(100),
  caller_prompt: z.string().min(1),
  caller_prompts: z.array(z.string().min(1)).min(1).optional(),
  max_turns: z.number().int().min(1).max(10).optional(),
  ramps: z.array(z.number().int().min(1)).min(1).optional(),
  thresholds: LoadTestThresholdsSchema.partial().optional(),
  caller_audio: CallerAudioPoolSchema.optional(),
  language: z.string().min(2).max(5).optional(),
  spike_multiplier: z.number().min(1.5).max(5).optional(),
  soak_duration_min: z.number().min(1).max(60).optional(),
});

export const LoadTestBreakingPointSchema = z.object({
  concurrency: z.number(),
  triggered_by: z.array(z.enum(["error_rate", "p95_latency", "quality_drop"])),
  error_rate: z.number(),
  p95_ttfb_ms: z.number(),
  quality_score: z.number().optional(),
});

export const LoadTestGradingSchema = z.object({
  ttfw: LoadTestSeveritySchema,
  p95_latency: LoadTestSeveritySchema,
  error_rate: LoadTestSeveritySchema,
  quality: LoadTestSeveritySchema,
  overall: LoadTestSeveritySchema,
});

export const LoadTestEvalSummarySchema = z.object({
  total_evaluated: z.number().int().min(0),
  mean_quality_score: z.number().min(0).max(1),
  questions: z.array(z.object({
    question: z.string(),
    pass_rate: z.number().min(0).max(1),
  })),
});

export const LoadTestTierResultSchema = z.object({
  concurrency: z.number().int().min(1),
  total_calls: z.number().int().min(0),
  successful_calls: z.number().int().min(0),
  failed_calls: z.number().int().min(0),
  error_rate: z.number().min(0).max(1),
  ttfb_p50_ms: z.number(),
  ttfb_p95_ms: z.number(),
  ttfb_p99_ms: z.number(),
  ttfw_p50_ms: z.number(),
  ttfw_p95_ms: z.number(),
  ttfw_p99_ms: z.number(),
  connect_p50_ms: z.number(),
  mean_quality_score: z.number().min(0).max(1),
  quality_degradation_pct: z.number(),
  ttfb_degradation_pct: z.number(),
  duration_ms: z.number(),
  phase: z.enum(["ramp", "spike", "soak"]).optional(),
  latency_drift_slope: z.number().optional(),
  degraded: z.boolean().optional(),
});

export const LoadTestResultSchema = z.object({
  status: z.enum(["pass", "fail"]),
  severity: LoadTestSeveritySchema,
  target_concurrency: z.number(),
  tiers: z.array(LoadTestTierResultSchema),
  total_calls: z.number(),
  successful_calls: z.number(),
  failed_calls: z.number(),
  breaking_point: LoadTestBreakingPointSchema.optional(),
  grading: LoadTestGradingSchema,
  eval_summary: LoadTestEvalSummarySchema.optional(),
  thresholds: LoadTestThresholdsSchema,
  duration_ms: z.number(),
  spike: LoadTestTierResultSchema.optional(),
  soak: LoadTestTierResultSchema.optional(),
});
