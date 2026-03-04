import { z } from "zod";
import { AUDIO_TEST_NAMES, AUDIO_ACTION_TYPES, RED_TEAM_ATTACKS } from "./types.js";

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

export const InfrastructureProbeConfigSchema = z.object({
  prompt: z.string().optional(),
  audio_quality: z.object({ prompt: z.string().optional() }).optional(),
  latency: z.object({
    prompt: z.string().optional(),
    caller_prompt: z.string().optional(),
    turns: z.number().int().min(3).max(20).optional(),
  }).optional(),
  echo: z.object({
    prompt: z.string().optional(),
    silence_duration_ms: z.number().int().min(5000).max(60000).optional(),
  }).optional(),
}).optional();

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

export const ConversationTestSpecSchema = z.object({
  name: z.string().optional(),
  caller_prompt: z.string().min(1),
  max_turns: z.number().int().min(1).max(50).default(6),
  eval: z.array(z.string().min(1)).min(1),
  tool_call_eval: z.array(z.string().min(1)).optional(),
  silence_threshold_ms: z.number().int().min(200).max(10000).optional(),
  persona: CallerPersonaSchema,
  audio_actions: z.array(AudioActionSchema).optional(),
  prosody: z.boolean().optional(),
});

export const RedTeamAttackSchema = z.enum(RED_TEAM_ATTACKS);

export const TestSpecSchema = z
  .object({
    infrastructure: InfrastructureProbeConfigSchema,
    conversation_tests: z.array(ConversationTestSpecSchema).optional(),
    red_team: z.array(RedTeamAttackSchema).optional(),
  })
  .refine(
    (d) =>
      (d.infrastructure ? 1 : 0) +
      (d.conversation_tests?.length ?? 0) +
      (d.red_team?.length ?? 0) > 0,
    { message: "At least one of infrastructure, conversation_tests, or red_team is required" }
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
    tts_synthesis_ms: z.number().optional(),
    audio_send_ms: z.number().optional(),
    agent_response_wait_ms: z.number().optional(),
    stt_transcription_ms: z.number().optional(),
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
});

export const EvalResultSchema = z.object({
  question: z.string(),
  relevant: z.boolean(),
  passed: z.boolean(),
  reasoning: z.string(),
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
  top_emotions: z.array(z.object({ name: z.string(), score: z.number() })),
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

export const ConversationMetricsSchema = z.object({
  turns: z.number(),
  mean_ttfb_ms: z.number(),
  mean_ttfw_ms: z.number().optional(),
  total_duration_ms: z.number(),
  talk_ratio: z.number().optional(),
  transcript: TranscriptMetricsSchema.optional(),
  latency: LatencyMetricsSchema.optional(),
  behavioral: BehavioralMetricsSchema.optional(),
  tool_calls: ToolCallMetricsSchema.optional(),
  audio_analysis: AudioAnalysisMetricsSchema.optional(),
  audio_analysis_warnings: z.array(AudioAnalysisWarningSchema).optional(),
  prosody: ProsodyMetricsSchema.optional(),
  prosody_warnings: z.array(ProsodyWarningSchema).optional(),
  harness_overhead: HarnessOverheadSchema.optional(),
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
  status: z.enum(["pass", "fail"]),
  transcript: z.array(ConversationTurnSchema),
  eval_results: z.array(EvalResultSchema),
  tool_call_eval_results: z.array(EvalResultSchema).optional(),
  observed_tool_calls: z.array(ObservedToolCallSchema).optional(),
  audio_action_results: z.array(AudioActionResultSchema).optional(),
  duration_ms: z.number(),
  metrics: ConversationMetricsSchema,
  error: z.string().optional(),
  diagnostics: TestDiagnosticsSchema.optional(),
});

export const RunAggregateV2Schema = z.object({
  infrastructure: z.object({
    total: z.number(),
    completed: z.number(),
    errored: z.number(),
  }),
  conversation_tests: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
  }),
  load_tests: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
  }).optional(),
  total_duration_ms: z.number(),
});

export const RunnerCallbackV2Schema = z.object({
  run_id: z.string().uuid(),
  status: z.enum(["pass", "fail"]),
  infrastructure_results: z.array(AudioTestResultSchema),
  conversation_results: z.array(ConversationTestResultSchema),
  aggregate: RunAggregateV2Schema,
  error_text: z.string().optional(),
});

// ============================================================
// Load testing schemas
// ============================================================

export const LoadPatternSchema = z.enum(["ramp", "spike", "sustained", "soak"]);

export const LoadTestTimepointSchema = z.object({
  elapsed_s: z.number(),
  active_connections: z.number(),
  ttfb_p50_ms: z.number(),
  ttfb_p95_ms: z.number(),
  ttfb_p99_ms: z.number(),
  error_rate: z.number(),
  errors_cumulative: z.number(),
});

export const LoadTestResultSchema = z.object({
  status: z.enum(["pass", "fail"]),
  pattern: LoadPatternSchema,
  target_concurrency: z.number(),
  actual_peak_concurrency: z.number(),
  total_calls: z.number(),
  successful_calls: z.number(),
  failed_calls: z.number(),
  timeline: z.array(LoadTestTimepointSchema),
  summary: z.object({
    ttfb_p50_ms: z.number(),
    ttfb_p95_ms: z.number(),
    ttfb_p99_ms: z.number(),
    error_rate: z.number(),
    breaking_point: z.number().optional(),
    mean_call_duration_ms: z.number(),
  }),
  duration_ms: z.number(),
});
