import type {
  AudioTestResult,
  ConversationTestResult,
  ConversationTestSpec,
  EvalResult,
  ObservedToolCall,
  TestSpec,
} from "@voiceci/shared";

interface StoredSpecContext {
  adapter: string | null;
  agent_url: string | null;
  target_phone_number: string | null;
  platform_provider: string | null;
  has_platform_config: boolean;
  has_voice_overrides: boolean;
  has_audio_threshold_overrides: boolean;
}

interface ThresholdBreach {
  metric: string;
  value: number;
  threshold_metric: string;
  threshold_value: number;
}

interface FailedEvalEvidence {
  question: string;
  reasoning: string;
}

export interface FixPacket {
  id: string;
  category: string;
  test_type: "audio" | "conversation";
  test_name: string;
  evidence: Record<string, unknown>;
}

export interface FixPlan {
  failing_tests: number;
  top_priority: string | null;
  prioritized_packets: FixPacket[];
  targeted_rerun_config: Record<string, unknown> | null;
}

interface BuildFixPlanInput {
  audioResults: unknown[];
  conversationResults: unknown[];
  testSpecJson?: Record<string, unknown> | null;
}

export function buildFixPlan(input: BuildFixPlanInput): FixPlan | null {
  const audioResults = normalizeAudioResults(input.audioResults);
  const conversationResults = normalizeConversationResults(input.conversationResults);
  const failedAudio = audioResults.filter((r) => r.status === "fail");
  const failedConversation = conversationResults.filter((r) => r.status === "fail");

  if (failedAudio.length === 0 && failedConversation.length === 0) {
    return null;
  }

  const context = parseStoredSpec(input.testSpecJson ?? null);
  const packets: FixPacket[] = [
    ...failedAudio.map((r) => buildAudioFixPacket(r, context)),
    ...failedConversation.map((r) => buildConversationFixPacket(r, context)),
  ];

  return {
    failing_tests: packets.length,
    top_priority: packets[0]?.id ?? null,
    prioritized_packets: packets,
    targeted_rerun_config: buildTargetedRerunConfig(
      failedAudio,
      failedConversation,
      input.testSpecJson ?? null,
    ),
  };
}

function buildAudioFixPacket(result: AudioTestResult, context: StoredSpecContext): FixPacket {
  const thresholdBreaches = numericThresholdPairs(result.metrics).map((p) => ({
    metric: p.metricKey,
    value: roundMetric(p.metric),
    threshold_metric: p.thresholdKey,
    threshold_value: roundMetric(p.threshold),
  }));
  const falseFlags = unique(
    Object.entries(result.metrics)
      .filter(([, value]) => value === false)
      .map(([key]) => key),
  ).sort();

  const notes: string[] = [];
  if (thresholdBreaches.length > 0) {
    notes.push(`${thresholdBreaches.length} threshold breach(es) detected.`);
  }
  if (falseFlags.length > 0) {
    notes.push(`${falseFlags.length} false health flag(s) detected.`);
  }
  if (notes.length === 0 && result.error) {
    notes.push(result.error);
  }
  if (notes.length === 0) {
    notes.push("Audio test failed without explicit threshold/flag signal.");
  }

  return {
    id: `audio:${result.test_name}`,
    category: "audio",
    test_type: "audio",
    test_name: result.test_name,
    evidence: {
      context,
      test_runtime: {
        duration_ms: result.duration_ms,
        metrics_count: Object.keys(result.metrics).length,
      },
      failure_signals: {
        error: result.error ?? null,
        threshold_breaches: thresholdBreaches,
        false_flags: falseFlags,
        notes: unique(notes),
      },
      metrics: sortRecordKeys(result.metrics),
      diagnostics: result.diagnostics ?? null,
    },
  };
}

function buildConversationFixPacket(
  result: ConversationTestResult,
  context: StoredSpecContext,
): FixPacket {
  const failedEvalResults = dedupeFailedEvalEvidence(failedEvals(result.eval_results));
  const failedToolCallEvalResults = dedupeFailedEvalEvidence(
    failedEvals(result.tool_call_eval_results ?? []),
  );
  const observedToolCalls = dedupeToolCalls(result.observed_tool_calls ?? []);
  const transcript = dedupeTranscriptExcerpt(result).slice(-12);

  const missingObservedToolCallsWhenExpected =
    failedToolCallEvalResults.length > 0 && observedToolCalls.length === 0;

  const notes: string[] = [];
  if (failedEvalResults.length > 0) {
    notes.push(`${failedEvalResults.length} failed eval criteria.`);
  }
  if (failedToolCallEvalResults.length > 0) {
    notes.push(`${failedToolCallEvalResults.length} failed tool-call eval criteria.`);
  }
  if (missingObservedToolCallsWhenExpected) {
    notes.push("Tool-call eval failed while zero observed_tool_calls were captured.");
  }
  if (result.error) {
    notes.push(result.error);
  }
  if (notes.length === 0) {
    notes.push("Conversation test failed without explicit eval/tool-call failure details.");
  }

  return {
    id: `conversation:${conversationId(result)}`,
    category: failedToolCallEvalResults.length > 0 ? "tool-calls" : "conversation",
    test_type: "conversation",
    test_name: result.name ?? "conversation",
    evidence: {
      context,
      test_runtime: {
        duration_ms: result.duration_ms,
        total_turns: result.transcript.length,
        excerpt_turns: transcript.length,
        eval_result_count: result.eval_results.length,
        tool_call_eval_result_count: (result.tool_call_eval_results ?? []).length,
      },
      failure_signals: {
        error: result.error ?? null,
        failed_eval_results: failedEvalResults,
        failed_tool_call_eval_results: failedToolCallEvalResults,
        missing_observed_tool_calls_when_expected: missingObservedToolCallsWhenExpected,
        notes: unique(notes),
      },
      transcript_excerpt: transcript,
      observed_tool_calls: observedToolCalls,
      metrics: result.metrics,
      diagnostics: result.diagnostics ?? null,
    },
  };
}

function numericThresholdPairs(metrics: Record<string, number | boolean>): Array<{
  metricKey: string;
  metric: number;
  thresholdKey: string;
  threshold: number;
}> {
  const pairs: Array<{
    metricKey: string;
    metric: number;
    thresholdKey: string;
    threshold: number;
  }> = [];

  const numericEntries = Object.entries(metrics)
    .filter(([, value]) => typeof value === "number")
    .map(([key, value]) => [key, value as number] as const);

  const thresholdEntries = numericEntries.filter(([key]) => /threshold/i.test(key));

  for (const [thresholdKey, threshold] of thresholdEntries) {
    const candidateMetrics = numericEntries.filter(([metricKey]) => {
      if (metricKey === thresholdKey) return false;
      if (/threshold/i.test(metricKey)) return false;
      // Compare only likely comparable metrics
      if (!/_ms$/.test(metricKey) && !/ratio|snr|count|p\d+/i.test(metricKey)) return false;
      return true;
    });

    for (const [metricKey, metric] of candidateMetrics) {
      if (metric > threshold) {
        pairs.push({ metricKey, metric, thresholdKey, threshold });
      }
    }
  }

  return uniqueBy(pairs, (p) => `${p.metricKey}:${p.thresholdKey}`);
}

function buildTargetedRerunConfig(
  failedAudioResults: AudioTestResult[],
  failedConversationResults: ConversationTestResult[],
  testSpecJson: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const audioTests = unique(failedAudioResults.map((r) => r.test_name));
  const conversationTests = focusedConversationTests(failedConversationResults, testSpecJson);

  if (audioTests.length === 0 && conversationTests.length === 0) {
    return null;
  }

  const spec = parseStoredSpecForRerun(testSpecJson);
  const rerunConfig: Record<string, unknown> = {
    adapter: spec.adapter ?? "websocket",
  };

  if (spec.agent_url) rerunConfig["agent_url"] = spec.agent_url;
  if (spec.target_phone_number) rerunConfig["target_phone_number"] = spec.target_phone_number;
  if (spec.platform) rerunConfig["platform"] = spec.platform;
  if (spec.voice) rerunConfig["voice"] = spec.voice;
  if (spec.audio_test_thresholds) rerunConfig["audio_test_thresholds"] = spec.audio_test_thresholds;
  if (audioTests.length > 0) rerunConfig["audio_tests"] = audioTests;
  if (conversationTests.length > 0) rerunConfig["conversation_tests"] = conversationTests;

  return rerunConfig;
}

function focusedConversationTests(
  failedConversationResults: ConversationTestResult[],
  testSpecJson: Record<string, unknown> | null,
): ConversationTestSpec[] {
  const originals = parseConversationSpecs(testSpecJson?.["conversation_tests"]);
  const focused = failedConversationResults.map((result) => {
    const original = matchConversationSpec(result, originals);
    const failedEvalQuestions = unique(failedEvals(result.eval_results).map((e) => e.question));
    const failedToolEvalQuestions = unique(
      failedEvals(result.tool_call_eval_results ?? []).map((e) => e.question),
    );
    const fallbackEval = unique((result.eval_results ?? []).map((e) => e.question))
      .filter((q) => q.length > 0);

    const maxTurns = clamp(
      Math.max(
        original?.max_turns ?? 8,
        Math.min((result.transcript?.length ?? 0) + 2, 20),
      ),
      6,
      20,
    );

    const evalQuestions = failedEvalQuestions.length > 0
      ? failedEvalQuestions
      : original?.eval && original.eval.length > 0
        ? unique(original.eval)
        : fallbackEval.length > 0
          ? fallbackEval
          : ["Did the agent satisfy the expected behavior from this scenario?"];

    const focusedSpec: ConversationTestSpec = {
      name: original?.name ?? result.name,
      caller_prompt: original?.caller_prompt ?? result.caller_prompt,
      max_turns: maxTurns,
      eval: evalQuestions,
    };

    const toolEval = failedToolEvalQuestions.length > 0
      ? failedToolEvalQuestions
      : original?.tool_call_eval && original.tool_call_eval.length > 0
        ? unique(original.tool_call_eval)
        : [];
    if (toolEval.length > 0) focusedSpec.tool_call_eval = toolEval;
    if (original?.silence_threshold_ms != null) focusedSpec.silence_threshold_ms = original.silence_threshold_ms;
    if (original?.persona) focusedSpec.persona = original.persona;
    if (original?.prosody != null) focusedSpec.prosody = original.prosody;

    return focusedSpec;
  });

  return uniqueBy(focused, (s) => `${s.name ?? ""}|${s.caller_prompt}`);
}

function dedupeTranscriptExcerpt(
  result: ConversationTestResult,
): Array<{
  role: "caller" | "agent";
  text: string;
  timestamp_ms: number;
  ttfb_ms?: number;
  ttfw_ms?: number;
  silence_pad_ms?: number;
}> {
  const excerpt = (result.transcript ?? []).map((turn) => ({
    role: turn.role,
    text: turn.text,
    timestamp_ms: turn.timestamp_ms,
    ttfb_ms: turn.ttfb_ms,
    ttfw_ms: turn.ttfw_ms,
    silence_pad_ms: turn.silence_pad_ms,
  }));

  return uniqueBy(
    excerpt,
    (t) => `${t.role}|${t.timestamp_ms}|${t.text}|${t.ttfb_ms ?? ""}|${t.ttfw_ms ?? ""}|${t.silence_pad_ms ?? ""}`,
  );
}

function dedupeToolCalls(calls: ObservedToolCall[]): ObservedToolCall[] {
  return uniqueBy(calls, (c) => {
    const args = stableStringify(c.arguments ?? {});
    const result = c.result != null ? stableStringify(c.result as Record<string, unknown>) : "";
    return `${c.name}|${c.timestamp_ms ?? ""}|${c.latency_ms ?? ""}|${args}|${result}|${c.successful ?? ""}`;
  });
}

function dedupeFailedEvalEvidence(evals: EvalResult[]): FailedEvalEvidence[] {
  const records = evals.map((e) => ({
    question: e.question,
    reasoning: e.reasoning,
  }));
  return uniqueBy(records, (r) => `${r.question}|${r.reasoning}`);
}

function failedEvals(evals: EvalResult[] | undefined): EvalResult[] {
  return (evals ?? []).filter((e) => e.relevant && !e.passed);
}

function normalizeAudioResults(results: unknown[]): AudioTestResult[] {
  return results
    .filter(isRecord)
    .filter((r) => typeof r["test_name"] === "string")
    .map((r) => r as unknown as AudioTestResult);
}

function normalizeConversationResults(results: unknown[]): ConversationTestResult[] {
  return results
    .filter(isRecord)
    .filter((r) => typeof r["caller_prompt"] === "string")
    .map((r) => r as unknown as ConversationTestResult);
}

function parseConversationSpecs(value: unknown): ConversationTestSpec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((v) => typeof v["caller_prompt"] === "string")
    .map((v) => v as unknown as ConversationTestSpec);
}

function matchConversationSpec(
  result: ConversationTestResult,
  specs: ConversationTestSpec[],
): ConversationTestSpec | undefined {
  return specs.find((s) => {
    if (result.name && s.name && s.name === result.name) return true;
    return s.caller_prompt === result.caller_prompt;
  });
}

function parseStoredSpec(specJson: Record<string, unknown> | null): StoredSpecContext {
  if (!specJson || !isRecord(specJson)) {
    return {
      adapter: null,
      agent_url: null,
      target_phone_number: null,
      platform_provider: null,
      has_platform_config: false,
      has_voice_overrides: false,
      has_audio_threshold_overrides: false,
    };
  }

  const voiceConfig = isRecord(specJson["voice_config"]) ? specJson["voice_config"] : null;
  const platform = specJson["platform"];
  const platformProvider = isRecord(platform) && typeof platform["provider"] === "string"
    ? platform["provider"]
    : null;

  return {
    adapter: str(specJson["adapter"]),
    agent_url: str(specJson["agent_url"]),
    target_phone_number: str(specJson["target_phone_number"]),
    platform_provider: platformProvider,
    has_platform_config: isRecord(platform),
    has_voice_overrides: voiceConfig != null && isRecord(voiceConfig["voice"]),
    has_audio_threshold_overrides: isRecord(specJson["audio_test_thresholds"]),
  };
}

function parseStoredSpecForRerun(specJson: Record<string, unknown> | null): {
  adapter: string | null;
  agent_url: string | null;
  target_phone_number: string | null;
  platform: unknown;
  voice: Record<string, unknown> | null;
  audio_test_thresholds: Record<string, unknown> | null;
} {
  if (!specJson || !isRecord(specJson)) {
    return {
      adapter: null,
      agent_url: null,
      target_phone_number: null,
      platform: null,
      voice: null,
      audio_test_thresholds: null,
    };
  }

  const voiceConfig = isRecord(specJson["voice_config"]) ? specJson["voice_config"] : null;

  return {
    adapter: str(specJson["adapter"]),
    agent_url: str(specJson["agent_url"]),
    target_phone_number: str(specJson["target_phone_number"]),
    platform: specJson["platform"] ?? null,
    voice: voiceConfig && isRecord(voiceConfig["voice"]) ? voiceConfig["voice"] : null,
    audio_test_thresholds: isRecord(specJson["audio_test_thresholds"])
      ? specJson["audio_test_thresholds"]
      : null,
  };
}

function conversationId(result: ConversationTestResult): string {
  if (result.name && result.name.length > 0) return result.name;
  return result.caller_prompt.slice(0, 32).replace(/\s+/g, "_");
}

function roundMetric(value: number): number {
  return Number.isInteger(value) ? value : Math.round(value * 1000) / 1000;
}

function sortRecordKeys(record: Record<string, number | boolean>): Record<string, number | boolean> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function stableStringify(value: Record<string, unknown> | unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  const sorted = Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const v = value[key];
      acc[key] = isRecord(v) ? JSON.parse(stableStringify(v)) : v;
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export type StoredTestSpecJson = (TestSpec & Record<string, unknown>) | null;
