/**
 * Load test coordinator — tiered quality-aware load testing.
 *
 * Fires increasing batches of simultaneous real conversations to find
 * exactly WHERE the agent breaks under load:
 *   Tier 1:  10% of target  → all finish → record metrics
 *   Tier 2:  25% of target  → all finish → record metrics
 *   Tier 3:  50% of target  → all finish → record metrics
 *   Tier 4: 100% of target  → all finish → record metrics
 *
 * Every concurrent call is a full multi-turn conversation:
 *   CallerLLM → TTS → send → collect via VAD → streaming STT → repeat.
 *
 * After all tiers, evaluate ALL transcripts with JudgeLLM for quality scoring.
 *
 * Breaking point: 2-of-3 signal detection (error rate, P95 latency, quality drop).
 * Severity grading: excellent / good / acceptable / critical.
 */

import type {
  LoadTestResult,
  LoadTestTierResult,
  LoadTestThresholds,
  LoadTestBreakingPoint,
  LoadTestGrading,
  LoadTestSeverity,
  LoadTestEvalSummary,
  ConversationTurn,
  EvalResult,
  CallerAudioEffects,
  CallerAudioPool,
} from "@voiceci/shared";
import { DEFAULT_LOAD_TEST_THRESHOLDS } from "@voiceci/shared";
import { createAudioChannel, type AudioChannelConfig } from "@voiceci/adapters";
import { synthesize, VoiceActivityDetector, StreamingTranscriber, applyEffects, resolveAccentVoiceId } from "@voiceci/voice";
import { collectUntilEndOfTurn } from "./audio-tests/helpers.js";
import { CallerLLM } from "./conversation/caller-llm.js";
import { JudgeLLM } from "./conversation/judge-llm.js";

// ============================================================
// Types
// ============================================================

export interface LoadTestOpts {
  channelConfig: AudioChannelConfig;
  targetConcurrency: number;
  callerPrompt: string;
  maxTurns?: number;
  evalQuestions?: string[];
  thresholds?: Partial<LoadTestThresholds>;
  callerAudioPool?: CallerAudioPool;
  onTierComplete?: (tier: LoadTestTierResult) => void;
}

interface CallResult {
  tierId: number;
  success: boolean;
  ttfbPerTurn: number[];
  ttfwPerTurn: number[];
  connectMs: number;
  durationMs: number;
  transcript: ConversationTurn[];
  error?: string;
}

// ============================================================
// Helpers
// ============================================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function computeTierSizes(target: number): number[] {
  const pcts = [0.1, 0.25, 0.5, 1.0];
  const sizes: number[] = [];
  for (const pct of pcts) {
    const size = Math.max(5, Math.round(target * pct));
    // Avoid duplicate sizes
    if (sizes.length === 0 || size > sizes[sizes.length - 1]!) {
      sizes.push(size);
    }
  }
  // Ensure final tier is exactly the target
  if (sizes[sizes.length - 1] !== target) {
    sizes[sizes.length - 1] = target;
  }
  return sizes;
}

/**
 * Run concurrent promises with a concurrency limit.
 */
async function promisePool<T>(
  items: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await items[idx]!();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ============================================================
// Caller audio randomization (per-caller effects from pool)
// ============================================================

function resolveNumeric(v: number | [number, number] | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0] + Math.random() * (v[1] - v[0]);
  return v;
}

function resolveChoice<T extends string>(v: T | T[] | undefined): T | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[Math.floor(Math.random() * v.length)];
  return v;
}

function resolveBoolean(v: boolean | number | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  return Math.random() < v;
}

function randomizeEffects(pool: CallerAudioPool): CallerAudioEffects {
  const effects: CallerAudioEffects = {};
  const speed = resolveNumeric(pool.speed as number | [number, number] | undefined);
  if (speed !== undefined) effects.speed = speed;
  const speakerphone = resolveBoolean(pool.speakerphone);
  if (speakerphone !== undefined) effects.speakerphone = speakerphone;
  const micDistance = resolveChoice(pool.mic_distance as string | string[] | undefined) as CallerAudioEffects["mic_distance"];
  if (micDistance !== undefined) effects.mic_distance = micDistance;
  const clarity = resolveNumeric(pool.clarity as number | [number, number] | undefined);
  if (clarity !== undefined) effects.clarity = clarity;
  const accent = resolveChoice(pool.accent as string | string[] | undefined);
  if (accent !== undefined) effects.accent = accent;
  const packetLoss = resolveNumeric(pool.packet_loss as number | [number, number] | undefined);
  if (packetLoss !== undefined) effects.packet_loss = packetLoss;
  const jitterMs = resolveNumeric(pool.jitter_ms as number | [number, number] | undefined);
  if (jitterMs !== undefined) effects.jitter_ms = jitterMs;
  if (pool.noise) {
    const noiseType = resolveChoice(
      (Array.isArray(pool.noise.type) ? pool.noise.type : [pool.noise.type]) as Array<"babble" | "white" | "pink">,
    );
    const snrDb = resolveNumeric(pool.noise.snr_db as number | [number, number]) ?? 10;
    if (noiseType) effects.noise = { type: noiseType, snr_db: snrDb };
  }
  return effects;
}

// ============================================================
// Single call execution (full multi-turn conversation)
// ============================================================

async function runSingleCall(
  channelConfig: AudioChannelConfig,
  callerPrompt: string,
  maxTurns: number,
  tierId: number,
  callerAudioEffects?: CallerAudioEffects,
): Promise<CallResult> {
  const start = Date.now();
  const transcript: ConversationTurn[] = [];
  const ttfbPerTurn: number[] = [];
  const ttfwPerTurn: number[] = [];

  const caller = new CallerLLM(callerPrompt);
  const vad = new VoiceActivityDetector({ silenceThresholdMs: 2000 });
  const transcriber = new StreamingTranscriber();

  // Generate first utterance while initializing VAD + STT
  const [, , firstUtterance] = await Promise.all([
    vad.init(),
    transcriber.connect(),
    caller.nextUtterance(null, []),
  ]);

  if (!firstUtterance) {
    vad.destroy();
    transcriber.close();
    return {
      tierId,
      success: false,
      ttfbPerTurn: [],
      ttfwPerTurn: [],
      connectMs: 0,
      durationMs: Date.now() - start,
      transcript: [],
      error: "CallerLLM returned no utterance",
    };
  }

  // Resolve accent → TTS voice ID (consistent for this caller's entire conversation)
  const ttsVoiceId = callerAudioEffects?.accent
    ? resolveAccentVoiceId(callerAudioEffects.accent)
    : undefined;
  const ttsOpts = ttsVoiceId ? { voiceId: ttsVoiceId } : undefined;

  // Pre-synthesize first turn audio
  let callerText: string | null = firstUtterance;
  let callerAudio = await synthesize(firstUtterance, ttsOpts);
  if (callerAudioEffects) callerAudio = applyEffects(callerAudio, callerAudioEffects);

  // Connect channel
  const channel = createAudioChannel(channelConfig);
  const connectStart = Date.now();
  try {
    await channel.connect();
  } catch (err) {
    vad.destroy();
    transcriber.close();
    return {
      tierId,
      success: false,
      ttfbPerTurn: [],
      ttfwPerTurn: [],
      connectMs: Date.now() - connectStart,
      durationMs: Date.now() - start,
      transcript: [],
      error: `Connect failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const connectMs = Date.now() - connectStart;

  let agentText: string | null = null;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      // On turn > 0, generate next utterance from CallerLLM
      if (turn > 0) {
        callerText = await caller.nextUtterance(agentText, transcript);
        if (callerText === null) break; // CallerLLM ended conversation
        callerAudio = await synthesize(callerText, ttsOpts);
        if (callerAudioEffects) callerAudio = applyEffects(callerAudio, callerAudioEffects);
      }

      // Record caller turn
      transcript.push({
        role: "caller",
        text: callerText!,
        timestamp_ms: Date.now() - start,
      });

      // Pipe agent audio to streaming STT during collection
      transcriber.resetForNextTurn();
      const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
      channel.on("audio", feedSTT);

      const sendTime = Date.now();
      channel.sendAudio(callerAudio);

      // Collect agent response via VAD
      const { audio: agentAudio, stats } = await collectUntilEndOfTurn(
        channel,
        { timeoutMs: 15000, vad },
      );
      channel.off("audio", feedSTT);

      // Compute TTFB and TTFW for this turn
      let turnTtfb = 0;
      let turnTtfw = 0;
      if (agentAudio.length > 0 && stats.firstChunkAt !== null) {
        turnTtfb = Math.max(0, stats.firstChunkAt - sendTime);
        if (stats.speechOnsetAt !== null) {
          turnTtfw = Math.max(0, stats.speechOnsetAt - sendTime);
        }
      }
      ttfbPerTurn.push(turnTtfb);
      ttfwPerTurn.push(turnTtfw);

      // Finalize streaming STT to get agent's response text
      const { text } = await transcriber.finalize();
      agentText = text || "[no response]";

      transcript.push({
        role: "agent",
        text: agentText,
        timestamp_ms: Date.now() - start,
        ttfb_ms: turnTtfb,
        ttfw_ms: turnTtfw,
      });
    }

    vad.destroy();
    transcriber.close();

    return {
      tierId,
      success: true,
      ttfbPerTurn,
      ttfwPerTurn,
      connectMs,
      durationMs: Date.now() - start,
      transcript,
    };
  } catch (err) {
    vad.destroy();
    transcriber.close();
    return {
      tierId,
      success: false,
      ttfbPerTurn,
      ttfwPerTurn,
      connectMs,
      durationMs: Date.now() - start,
      transcript,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await channel.disconnect().catch(() => {});
  }
}

// ============================================================
// Tier execution
// ============================================================

function buildTierMetrics(
  concurrency: number,
  results: CallResult[],
  baselineTtfb?: number,
): LoadTestTierResult {
  const successful = results.filter((r) => r.success);

  // Flatten per-turn latencies across all successful calls
  const ttfbs = successful.flatMap((r) => r.ttfbPerTurn).sort((a, b) => a - b);
  const ttfws = successful.flatMap((r) => r.ttfwPerTurn).sort((a, b) => a - b);
  const connects = successful.map((r) => r.connectMs).sort((a, b) => a - b);
  const durations = results.map((r) => r.durationMs);

  const p95Ttfb = percentile(ttfbs, 95);
  const ttfbDegradation = baselineTtfb != null && baselineTtfb > 0
    ? Math.round(((p95Ttfb - baselineTtfb) / baselineTtfb) * 100)
    : 0;

  return {
    concurrency,
    total_calls: results.length,
    successful_calls: successful.length,
    failed_calls: results.length - successful.length,
    error_rate: results.length > 0 ? (results.length - successful.length) / results.length : 0,
    ttfb_p50_ms: percentile(ttfbs, 50),
    ttfb_p95_ms: p95Ttfb,
    ttfb_p99_ms: percentile(ttfbs, 99),
    ttfw_p50_ms: percentile(ttfws, 50),
    ttfw_p95_ms: percentile(ttfws, 95),
    ttfw_p99_ms: percentile(ttfws, 99),
    connect_p50_ms: percentile(connects, 50),
    // Quality metrics filled in by post-call pipeline
    mean_quality_score: 0,
    quality_degradation_pct: 0,
    ttfb_degradation_pct: ttfbDegradation,
    duration_ms: Math.max(...durations, 0),
  };
}

// ============================================================
// Post-call pipeline: evaluate transcripts with JudgeLLM
// ============================================================

async function runPostCallPipeline(
  callResults: CallResult[],
  evalQuestions: string[],
): Promise<{
  evalSummary: LoadTestEvalSummary | undefined;
  perTierQuality: Map<number, number>;
}> {
  const successfulCalls = callResults.filter(
    (r) => r.success && r.transcript.length > 0,
  );

  if (successfulCalls.length === 0 || evalQuestions.length === 0) {
    return { evalSummary: undefined, perTierQuality: new Map() };
  }

  // Batch-evaluate all transcripts with JudgeLLM (100 concurrent)
  console.log(`  Evaluating ${successfulCalls.length} transcript(s) against ${evalQuestions.length} question(s)...`);
  const judge = new JudgeLLM();
  const evalTasks = successfulCalls.map((call) => () =>
    judge.evaluate(call.transcript, evalQuestions).then((results) => ({
      tierId: call.tierId,
      results,
    })),
  );
  const evalResults = await promisePool(evalTasks, 100);

  // Compute quality scores per call and per tier
  const perTierScores = new Map<number, number[]>();
  const perQuestionPassed = new Map<string, number>();
  evalQuestions.forEach((q) => perQuestionPassed.set(q, 0));

  for (const { tierId, results } of evalResults) {
    const score = results.length > 0
      ? results.filter((r: EvalResult) => r.passed).length / results.length
      : 0;
    if (!perTierScores.has(tierId)) perTierScores.set(tierId, []);
    perTierScores.get(tierId)!.push(score);

    for (const r of results) {
      if (r.passed) {
        perQuestionPassed.set(r.question, (perQuestionPassed.get(r.question) ?? 0) + 1);
      }
    }
  }

  // Mean quality per tier
  const perTierQuality = new Map<number, number>();
  for (const [tierId, scores] of perTierScores) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    perTierQuality.set(tierId, Math.round(mean * 1000) / 1000);
  }

  // Build eval summary
  const allScores = evalResults.map((er) =>
    er.results.length > 0
      ? er.results.filter((r: EvalResult) => r.passed).length / er.results.length
      : 0,
  );
  const meanQuality = allScores.length > 0
    ? allScores.reduce((a, b) => a + b, 0) / allScores.length
    : 0;

  const evalSummary: LoadTestEvalSummary = {
    total_evaluated: evalResults.length,
    mean_quality_score: Math.round(meanQuality * 1000) / 1000,
    questions: evalQuestions.map((q) => ({
      question: q,
      pass_rate: evalResults.length > 0
        ? Math.round(((perQuestionPassed.get(q) ?? 0) / evalResults.length) * 1000) / 1000
        : 0,
    })),
  };

  return { evalSummary, perTierQuality };
}

// ============================================================
// Breaking point detection (2-of-3 signals)
// ============================================================

function detectBreakingPoint(
  tiers: LoadTestTierResult[],
  thresholds: LoadTestThresholds,
): LoadTestBreakingPoint | undefined {
  for (const tier of tiers) {
    const signals: Array<"error_rate" | "p95_latency" | "quality_drop"> = [];

    if (tier.error_rate > thresholds.error_rate[2]) {
      signals.push("error_rate");
    }
    if (tier.ttfb_p95_ms > thresholds.p95_latency_ms[2]) {
      signals.push("p95_latency");
    }
    if (tier.mean_quality_score > 0 && tier.mean_quality_score < thresholds.quality_score[2]) {
      signals.push("quality_drop");
    }

    if (signals.length >= 2) {
      return {
        concurrency: tier.concurrency,
        triggered_by: signals,
        error_rate: tier.error_rate,
        p95_ttfb_ms: tier.ttfb_p95_ms,
        quality_score: tier.mean_quality_score > 0 ? tier.mean_quality_score : undefined,
      };
    }
  }

  return undefined;
}

// ============================================================
// Severity grading
// ============================================================

function gradeSingle(
  value: number,
  thresholds: [number, number, number],
  higherIsBetter: boolean,
): LoadTestSeverity {
  if (higherIsBetter) {
    if (value >= thresholds[0]) return "excellent";
    if (value >= thresholds[1]) return "good";
    if (value >= thresholds[2]) return "acceptable";
    return "critical";
  }
  if (value <= thresholds[0]) return "excellent";
  if (value <= thresholds[1]) return "good";
  if (value <= thresholds[2]) return "acceptable";
  return "critical";
}

const SEVERITY_ORDER: LoadTestSeverity[] = ["excellent", "good", "acceptable", "critical"];

function worstSeverity(...grades: LoadTestSeverity[]): LoadTestSeverity {
  let worst = 0;
  for (const g of grades) {
    const idx = SEVERITY_ORDER.indexOf(g);
    if (idx > worst) worst = idx;
  }
  return SEVERITY_ORDER[worst]!;
}

function gradeLoadTest(
  finalTier: LoadTestTierResult,
  thresholds: LoadTestThresholds,
): LoadTestGrading {
  const ttfw = gradeSingle(finalTier.ttfw_p95_ms, thresholds.ttfw_ms, false);
  const p95_latency = gradeSingle(finalTier.ttfb_p95_ms, thresholds.p95_latency_ms, false);
  const error_rate = gradeSingle(finalTier.error_rate, thresholds.error_rate, false);
  const quality = finalTier.mean_quality_score > 0
    ? gradeSingle(finalTier.mean_quality_score, thresholds.quality_score, true)
    : "good"; // No eval → assume good

  return {
    ttfw,
    p95_latency,
    error_rate,
    quality,
    overall: worstSeverity(ttfw, p95_latency, error_rate, quality),
  };
}

// ============================================================
// Main entry point
// ============================================================

export async function runLoadTest(opts: LoadTestOpts): Promise<LoadTestResult> {
  const {
    channelConfig,
    targetConcurrency,
    callerPrompt,
    maxTurns = 6,
    evalQuestions = [],
    callerAudioPool,
    onTierComplete,
  } = opts;

  // Merge user thresholds with defaults
  const thresholds: LoadTestThresholds = {
    ...DEFAULT_LOAD_TEST_THRESHOLDS,
    ...opts.thresholds,
  };

  const tierSizes = computeTierSizes(targetConcurrency);
  console.log(`Load test starting: target=${targetConcurrency}, tiers=[${tierSizes.join(", ")}]`);

  const startTime = Date.now();
  const allCallResults: CallResult[] = [];
  const tierResults: LoadTestTierResult[] = [];
  let baselineP95Ttfb: number | undefined;

  // Run each tier sequentially
  for (let i = 0; i < tierSizes.length; i++) {
    const concurrency = tierSizes[i]!;
    console.log(`  Tier ${i + 1}: firing ${concurrency} concurrent call(s)...`);

    const tierStart = Date.now();

    // Fire all calls simultaneously — each is a full multi-turn conversation
    // Each caller gets independently randomized audio effects (if pool configured)
    const calls = Array.from({ length: concurrency }, () => {
      const effects = callerAudioPool ? randomizeEffects(callerAudioPool) : undefined;
      return runSingleCall(channelConfig, callerPrompt, maxTurns, i, effects);
    });
    const results = await Promise.all(calls);
    allCallResults.push(...results);

    const successful = results.filter((r) => r.success).length;
    const failed = results.length - successful;
    console.log(`  Tier ${i + 1} complete: ${successful} success, ${failed} failed, ${Date.now() - tierStart}ms`);

    // Build tier metrics
    const tierMetrics = buildTierMetrics(concurrency, results, baselineP95Ttfb);

    // First tier sets the baseline
    if (i === 0) {
      baselineP95Ttfb = tierMetrics.ttfb_p95_ms;
    }

    tierResults.push(tierMetrics);
    onTierComplete?.(tierMetrics);
  }

  // Post-call pipeline: evaluate ALL transcripts with JudgeLLM
  console.log("  Running post-call evaluation...");
  const { evalSummary, perTierQuality } = await runPostCallPipeline(
    allCallResults,
    evalQuestions,
  );

  // Fill in quality scores on tier results
  const baselineQuality = perTierQuality.get(0) ?? 0;
  for (let i = 0; i < tierResults.length; i++) {
    const quality = perTierQuality.get(i) ?? 0;
    tierResults[i]!.mean_quality_score = quality;
    tierResults[i]!.quality_degradation_pct = baselineQuality > 0
      ? Math.round(((baselineQuality - quality) / baselineQuality) * 100)
      : 0;
  }

  // Detect breaking point (2-of-3 signals)
  const breakingPoint = detectBreakingPoint(tierResults, thresholds);

  // Grade severity from the final tier
  const finalTier = tierResults[tierResults.length - 1]!;
  const grading = gradeLoadTest(finalTier, thresholds);

  // Total counts
  const totalCalls = allCallResults.length;
  const successfulCalls = allCallResults.filter((r) => r.success).length;
  const failedCalls = totalCalls - successfulCalls;

  const result: LoadTestResult = {
    status: grading.overall === "critical" ? "fail" : "pass",
    severity: grading.overall,
    target_concurrency: targetConcurrency,
    tiers: tierResults,
    total_calls: totalCalls,
    successful_calls: successfulCalls,
    failed_calls: failedCalls,
    breaking_point: breakingPoint,
    grading,
    eval_summary: evalSummary,
    thresholds,
    duration_ms: Date.now() - startTime,
  };

  console.log(
    `Load test complete: ${result.status} (${result.severity}) — ${result.total_calls} calls, ` +
    `${result.successful_calls} success, ${result.failed_calls} failed` +
    (breakingPoint ? `, breaking point: ${breakingPoint.concurrency} concurrent` : ""),
  );

  return result;
}
