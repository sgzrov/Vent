/**
 * Latency probe (Layer 1: Infrastructure)
 *
 * Measures TTFB, TTFW per turn on a single persistent channel.
 * Detects cold start (first turn), drift over conversation, and computes percentiles.
 *
 * Multi-turn: uses CallerLLM (Haiku) briefed via caller_prompt.
 * Single-turn fallback: uses provided prompt for one measurement.
 *
 * Returns raw metrics + transcriptions — no pass/fail.
 */

import type { AudioChannel } from "@vent/adapters";
import type { AudioTestResult } from "@vent/shared";
import { synthesize, VoiceActivityDetector, StreamingTranscriber } from "@vent/voice";
import { CallerLLM } from "../conversation/caller-llm.js";
import { collectUntilEndOfTurn, linearRegressionSlope } from "./helpers.js";

const DEFAULT_PROMPT = "I have a general question about your services. What do you offer?";
const DEFAULT_TURNS = 5;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export async function runLatencyTest(
  channel: AudioChannel,
  config?: { prompt?: string; caller_prompt?: string; turns?: number },
): Promise<AudioTestResult> {
  const turns = config?.turns ?? DEFAULT_TURNS;
  const startTime = performance.now();

  const ttfbValues: number[] = [];
  const ttfwValues: number[] = [];
  const transcriptions: string[] = [];

  const vad = new VoiceActivityDetector({ silenceThresholdMs: 800 });
  const transcriber = new StreamingTranscriber();

  await Promise.all([vad.init(), transcriber.connect()]);

  try {
    // Multi-turn mode with CallerLLM
    if (config?.caller_prompt || !config?.prompt) {
      const callerPrompt = config?.caller_prompt ?? DEFAULT_PROMPT;
      const caller = new CallerLLM(callerPrompt);

      let agentText: string | null = null;

      for (let turn = 0; turn < turns; turn++) {
        const callerDecision = await caller.nextUtterance(agentText, []);
        if (!callerDecision || callerDecision.mode === "end_now" || callerDecision.mode === "wait") break;
        const callerText = callerDecision.text;
        const shouldStopAfterAgentReply = callerDecision.mode === "closing";

        const callerAudio = await synthesize(callerText);

        // Pipe agent audio to STT
        transcriber.resetForNextTurn();
        const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
        channel.on("audio", feedSTT);

        const sendTime = Date.now();
        await channel.sendAudio(callerAudio);

        const { audio: agentAudio, stats } = await collectUntilEndOfTurn(channel, {
          timeoutMs: 15000,
          vad,
        });

        channel.off("audio", feedSTT);

        // Measure TTFB and TTFW
        if (agentAudio.length > 0 && stats.firstChunkAt !== null) {
          const ttfb = Math.max(0, stats.firstChunkAt - sendTime);
          ttfbValues.push(ttfb);

          if (stats.speechOnsetAt !== null) {
            const ttfw = Math.max(0, stats.speechOnsetAt - sendTime);
            ttfwValues.push(ttfw);
          }
        }

        // Transcribe
        if (agentAudio.length > 0) {
          const { text } = await transcriber.finalize();
          agentText = text;
          transcriptions.push(text);
        } else {
          agentText = "";
          transcriptions.push("");
        }

        if (shouldStopAfterAgentReply) break;
      }
    } else {
      // Single-turn mode with provided prompt (repeated for turns)
      for (let turn = 0; turn < turns; turn++) {
        const callerAudio = await synthesize(config.prompt);

        transcriber.resetForNextTurn();
        const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
        channel.on("audio", feedSTT);

        const sendTime = Date.now();
        await channel.sendAudio(callerAudio);

        const { audio: agentAudio, stats } = await collectUntilEndOfTurn(channel, {
          timeoutMs: 15000,
          vad,
        });

        channel.off("audio", feedSTT);

        if (agentAudio.length > 0 && stats.firstChunkAt !== null) {
          ttfbValues.push(Math.max(0, stats.firstChunkAt - sendTime));
          if (stats.speechOnsetAt !== null) {
            ttfwValues.push(Math.max(0, stats.speechOnsetAt - sendTime));
          }
        }

        if (agentAudio.length > 0) {
          const { text } = await transcriber.finalize();
          transcriptions.push(text);
        } else {
          transcriptions.push("");
        }
      }
    }

    // Compute metrics
    const sortedTtfb = [...ttfbValues].sort((a, b) => a - b);
    const sortedTtfw = [...ttfwValues].sort((a, b) => a - b);

    return {
      test_name: "latency",
      status: "completed",
      metrics: {
        ttfb_ms: ttfbValues,
        ttfw_ms: ttfwValues,
        cold_start_ttfb_ms: ttfbValues[0] ?? 0,
        drift_slope_ms_per_turn: Math.round(linearRegressionSlope(ttfbValues) * 100) / 100,
        p50_ttfb_ms: Math.round(percentile(sortedTtfb, 50)),
        p95_ttfb_ms: Math.round(percentile(sortedTtfb, 95)),
        p50_ttfw_ms: Math.round(percentile(sortedTtfw, 50)),
        p95_ttfw_ms: Math.round(percentile(sortedTtfw, 95)),
        turns_measured: ttfbValues.length,
      },
      transcriptions: {
        responses: transcriptions.length > 0 ? transcriptions : null,
      },
      duration_ms: Math.round(performance.now() - startTime),
    };
  } finally {
    transcriber.close();
    vad.destroy();
  }
}
