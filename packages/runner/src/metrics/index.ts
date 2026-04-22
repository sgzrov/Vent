/**
 * Metric orchestrator — computes transcript + latency + harness overhead metrics.
 */

import type {
  ConversationTurn,
  LatencyMetrics,
  HarnessOverhead,
} from "@vent/shared";
import { computeLatencyMetrics, computeHarnessOverhead } from "./latency.js";

export interface ComputedMetrics {
  latency: LatencyMetrics;
  harness_overhead: HarnessOverhead | undefined;
}

/**
 * Compute all non-LLM metrics from conversation turns.
 */
export async function computeAllMetrics(
  turns: ConversationTurn[],
  connectLatencyMs?: number,
): Promise<ComputedMetrics> {
  const latency = computeLatencyMetrics(turns, connectLatencyMs);
  const harness_overhead = computeHarnessOverhead(turns);
  return { latency, harness_overhead };
}

export { computeLatencyMetrics, computeHarnessOverhead } from "./latency.js";
export { analyzeProsody } from "./prosody.js";
