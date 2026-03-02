/**
 * TTFB (Time To First Byte) test — measures agent response latency.
 *
 * Procedure:
 * 1. Send tiered prompts: simple, complex, and tool-triggering
 * 2. For each prompt, measure TTFB (first audio byte) and TTFW (first word via VAD)
 * 3. Report overall and per-tier p50/p95
 * 4. PASS if p95 TTFB < threshold, FAIL otherwise
 */

import type { AudioChannel } from "@voiceci/adapters";
import type { AudioTestResult, AudioTestThresholds } from "@voiceci/shared";
import { synthesize, BatchVAD } from "@voiceci/voice";
import { waitForSpeech, collectUntilEndOfTurn } from "./helpers.js";

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
  const tierTtfb: Record<Tier, number[]> = { simple: [], complex: [], tool: [] };

  // Initialize BatchVAD for TTFW measurement
  const batchVAD = new BatchVAD();
  await batchVAD.init();

  try {
    for (const prompt of PROMPTS) {
      const audio = await synthesize(prompt.text);
      const sendTime = Date.now();
      channel.sendAudio(audio);

      const { detectedAt, timedOut } = await waitForSpeech(channel, 10000);

      if (!timedOut && detectedAt > 0) {
        const ttfb = detectedAt - sendTime;
        allTtfb.push(ttfb);
        tierTtfb[prompt.tier].push(ttfb);
      }

      // Collect agent response for TTFW analysis
      const { audio: agentAudio } = await collectUntilEndOfTurn(channel, {
        timeoutMs: 10000,
        silenceThresholdMs: 1000,
      });

      // TTFW: find first speech onset in collected audio via BatchVAD
      if (agentAudio.length > 0 && !timedOut && detectedAt > 0) {
        const ttfb = detectedAt - sendTime;
        // Analyze first 2s of agent audio
        const maxBytes = 2 * 24000 * 2; // 2 seconds of 24kHz 16-bit
        const segment = agentAudio.subarray(0, Math.min(agentAudio.length, maxBytes));
        const segments = batchVAD.analyze(segment);

        if (segments.length > 0) {
          // TTFW = TTFB + offset to first speech segment
          const ttfw = ttfb + segments[0]!.startMs;
          allTtfw.push(ttfw);
        }
      }
    }
  } finally {
    batchVAD.destroy();
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

  // Overall percentiles
  const sortedAll = [...allTtfb].sort((a, b) => a - b);
  const p50All = percentile(sortedAll, 0.5);
  const p95All = percentile(sortedAll, 0.95);

  // Per-tier stats
  const sortedSimple = [...tierTtfb.simple].sort((a, b) => a - b);
  const sortedComplex = [...tierTtfb.complex].sort((a, b) => a - b);
  const sortedTool = [...tierTtfb.tool].sort((a, b) => a - b);

  // TTFW percentiles
  const sortedTtfw = [...allTtfw].sort((a, b) => a - b);
  const p50Ttfw = percentile(sortedTtfw, 0.5);
  const p95Ttfw = percentile(sortedTtfw, 0.95);
  const ttfwDelta = allTtfw.length > 0 ? mean(allTtfw) - mean(allTtfb) : 0;

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
      mean_ttfb_ms: mean(allTtfb),
      p50_ttfb_ms: Math.round(p50All),
      p95_ttfb_ms: Math.round(p95All),
      threshold_ms: P95_THRESHOLD_MS,
      // Per-tier
      simple_mean_ttfb_ms: mean(tierTtfb.simple),
      simple_p95_ttfb_ms: Math.round(percentile(sortedSimple, 0.95)),
      complex_mean_ttfb_ms: mean(tierTtfb.complex),
      complex_p95_ttfb_ms: Math.round(percentile(sortedComplex, 0.95)),
      tool_mean_ttfb_ms: mean(tierTtfb.tool),
      tool_p95_ttfb_ms: Math.round(percentile(sortedTool, 0.95)),
      // TTFW
      mean_ttfw_ms: mean(allTtfw),
      p50_ttfw_ms: Math.round(p50Ttfw),
      p95_ttfw_ms: Math.round(p95Ttfw),
      ttfw_delta_ms: Math.round(ttfwDelta),
    },
    duration_ms: durationMs,
    ...(!passed && { error: errors.join("; ") }),
  };
}
