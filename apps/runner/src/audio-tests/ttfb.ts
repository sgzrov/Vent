/**
 * TTFB (Time To First Byte) + TTFW (Time To First Word) test — measures agent response latency.
 *
 * Procedure:
 * 1. Send tiered prompts: simple, complex, and tool-triggering
 * 2. For each prompt, measure:
 *    - TTFB: time until first audio byte arrives (infrastructure latency)
 *    - TTFW: time until VAD detects first speech (perceived latency)
 *    - Silence Pad: TTFW - TTFB (dead audio before speech, TTS warmup diagnostic)
 * 3. Report overall and per-tier p50/p95
 * 4. PASS if p95 TTFB < threshold, FAIL otherwise
 */

import type { AudioChannel } from "@voiceci/adapters";
import type { AudioTestResult, AudioTestThresholds } from "@voiceci/shared";
import { synthesize, VoiceActivityDetector } from "@voiceci/voice";
import { collectUntilEndOfTurn } from "./helpers.js";

const DEFAULT_P95_THRESHOLD_MS = 3000;
const DEFAULT_P95_COMPLEX_THRESHOLD_MS = 5000;

type Tier = "simple" | "complex" | "tool";

interface TieredPrompt {
  text: string;
  tier: Tier;
}

const PROMPTS: TieredPrompt[] = [
  // Simple (greetings / short questions)
  { text: "Hello, how are you?", tier: "simple" },
  { text: "What time is it?", tier: "simple" },
  { text: "Can you help me?", tier: "simple" },
  // Complex (multi-part, requires reasoning)
  { text: "I need to reschedule my appointment from next Tuesday to the following Thursday, and also update my phone number on file.", tier: "complex" },
  { text: "Can you compare the features and pricing of your basic plan versus the premium plan?", tier: "complex" },
  // Tool-triggering (likely to invoke tool calls)
  { text: "Can you look up what appointments are available for next Monday?", tier: "tool" },
  { text: "I'd like to book an appointment for next Wednesday at 10am.", tier: "tool" },
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export async function runTtfbTest(
  channel: AudioChannel,
  thresholds?: AudioTestThresholds,
): Promise<AudioTestResult> {
  const P95_THRESHOLD_MS = thresholds?.ttfb?.p95_threshold_ms ?? DEFAULT_P95_THRESHOLD_MS;
  const P95_COMPLEX_THRESHOLD_MS = thresholds?.ttfb?.p95_complex_threshold_ms ?? DEFAULT_P95_COMPLEX_THRESHOLD_MS;
  const P95_TTFW_THRESHOLD_MS = thresholds?.ttfb?.p95_ttfw_threshold_ms;
  const startTime = performance.now();

  const allTtfb: number[] = [];
  const allTtfw: number[] = [];
  const allSilencePad: number[] = [];
  const tierTtfb: Record<Tier, number[]> = { simple: [], complex: [], tool: [] };
  const tierTtfw: Record<Tier, number[]> = { simple: [], complex: [], tool: [] };

  // Shared VAD instance — reused across all prompts to avoid WASM reload
  const vad = new VoiceActivityDetector({ silenceThresholdMs: 1000 });
  await vad.init();

  try {
    for (const prompt of PROMPTS) {
      const audio = await synthesize(prompt.text);
      const sendTime = Date.now();
      channel.sendAudio(audio);

      // Single-pass collection: tracks both firstChunkAt (TTFB) and speechOnsetAt (TTFW)
      const { stats } = await collectUntilEndOfTurn(channel, {
        timeoutMs: 10000,
        silenceThresholdMs: 1000,
        vad,
      });

      // TTFB: first audio byte back from agent
      if (stats.firstChunkAt !== null) {
        const ttfb = Math.max(0, stats.firstChunkAt - sendTime);
        allTtfb.push(ttfb);
        tierTtfb[prompt.tier].push(ttfb);

        // TTFW: first speech detected via VAD
        if (stats.speechOnsetAt !== null) {
          const ttfw = Math.max(0, stats.speechOnsetAt - sendTime);
          allTtfw.push(ttfw);
          tierTtfw[prompt.tier].push(ttfw);

          // Silence pad: dead audio before speech starts
          const silencePad = Math.max(0, ttfw - ttfb);
          allSilencePad.push(silencePad);
        }
      }
    }
  } finally {
    vad.destroy();
  }

  const MIN_RESPONSES = Math.max(1, PROMPTS.length - 2); // At least 5/7 prompts must get responses

  if (allTtfb.length === 0) {
    return {
      test_name: "ttfb",
      status: "fail",
      metrics: { responses_received: 0, total_prompts: PROMPTS.length },
      duration_ms: Math.round(performance.now() - startTime),
      error: "Agent did not respond to any prompts",
    };
  }

  if (allTtfb.length < MIN_RESPONSES) {
    return {
      test_name: "ttfb",
      status: "fail",
      metrics: { responses_received: allTtfb.length, total_prompts: PROMPTS.length },
      duration_ms: Math.round(performance.now() - startTime),
      error: `Agent only responded to ${allTtfb.length}/${PROMPTS.length} prompts (minimum ${MIN_RESPONSES})`,
    };
  }

  // Overall TTFB percentiles
  const sortedAll = [...allTtfb].sort((a, b) => a - b);
  const p50All = percentile(sortedAll, 0.5);
  const p95All = percentile(sortedAll, 0.95);

  // Per-tier TTFB stats
  const sortedSimple = [...tierTtfb.simple].sort((a, b) => a - b);
  const sortedComplex = [...tierTtfb.complex].sort((a, b) => a - b);
  const sortedTool = [...tierTtfb.tool].sort((a, b) => a - b);

  // TTFW percentiles
  const sortedTtfw = [...allTtfw].sort((a, b) => a - b);
  const p50Ttfw = percentile(sortedTtfw, 0.5);
  const p95Ttfw = percentile(sortedTtfw, 0.95);

  // Per-tier TTFW stats
  const sortedSimpleTtfw = [...tierTtfw.simple].sort((a, b) => a - b);
  const sortedComplexTtfw = [...tierTtfw.complex].sort((a, b) => a - b);
  const sortedToolTtfw = [...tierTtfw.tool].sort((a, b) => a - b);

  // Pass/fail
  let passed = p95All <= P95_THRESHOLD_MS;
  const errors: string[] = [];

  if (p95All > P95_THRESHOLD_MS) {
    errors.push(`overall p95 TTFB ${Math.round(p95All)}ms exceeds ${P95_THRESHOLD_MS}ms`);
  }

  if (sortedComplex.length > 0) {
    const p95Complex = percentile(sortedComplex, 0.95);
    if (p95Complex > P95_COMPLEX_THRESHOLD_MS) {
      passed = false;
      errors.push(`complex p95 TTFB ${Math.round(p95Complex)}ms exceeds ${P95_COMPLEX_THRESHOLD_MS}ms`);
    }
  }

  if (P95_TTFW_THRESHOLD_MS != null && sortedTtfw.length > 0 && p95Ttfw > P95_TTFW_THRESHOLD_MS) {
    passed = false;
    errors.push(`p95 TTFW ${Math.round(p95Ttfw)}ms exceeds ${P95_TTFW_THRESHOLD_MS}ms`);
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    test_name: "ttfb",
    status: passed ? "pass" : "fail",
    metrics: {
      responses_received: allTtfb.length,
      // Overall TTFB (first audio byte — infrastructure latency)
      mean_ttfb_ms: mean(allTtfb),
      p50_ttfb_ms: Math.round(p50All),
      p95_ttfb_ms: Math.round(p95All),
      threshold_ms: P95_THRESHOLD_MS,
      // Per-tier TTFB
      simple_mean_ttfb_ms: mean(tierTtfb.simple),
      simple_p95_ttfb_ms: Math.round(percentile(sortedSimple, 0.95)),
      complex_mean_ttfb_ms: mean(tierTtfb.complex),
      complex_p95_ttfb_ms: Math.round(percentile(sortedComplex, 0.95)),
      tool_mean_ttfb_ms: mean(tierTtfb.tool),
      tool_p95_ttfb_ms: Math.round(percentile(sortedTool, 0.95)),
      // Overall TTFW (first speech via VAD — perceived latency)
      mean_ttfw_ms: mean(allTtfw),
      p50_ttfw_ms: Math.round(p50Ttfw),
      p95_ttfw_ms: Math.round(p95Ttfw),
      // Per-tier TTFW
      simple_mean_ttfw_ms: mean(tierTtfw.simple),
      simple_p95_ttfw_ms: Math.round(percentile(sortedSimpleTtfw, 0.95)),
      complex_mean_ttfw_ms: mean(tierTtfw.complex),
      complex_p95_ttfw_ms: Math.round(percentile(sortedComplexTtfw, 0.95)),
      tool_mean_ttfw_ms: mean(tierTtfw.tool),
      tool_p95_ttfw_ms: Math.round(percentile(sortedToolTtfw, 0.95)),
      // Silence pad (TTFW - TTFB — dead audio before speech)
      mean_silence_pad_ms: mean(allSilencePad),
    },
    duration_ms: durationMs,
    ...(!passed && { error: errors.join("; ") }),
  };
}
