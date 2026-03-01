/**
 * Conversation test executor — runs a full dynamic conversation loop.
 *
 * Flow:
 * 1. Caller LLM generates text from persona prompt
 * 2. TTS → send audio to agent via AudioChannel
 * 3. Collect agent audio (VAD for end-of-turn)
 * 4. STT → text back to caller LLM
 * 5. Repeat until max_turns or caller says [END]
 * 6. Judge LLM evaluates transcript against eval questions
 */

import type { AudioChannel } from "@voiceci/adapters";
import type {
  ConversationTestSpec,
  ConversationTestResult,
  ConversationTurn,
  ConversationMetrics,
  ObservedToolCall,
  ToolCallMetrics,
} from "@voiceci/shared";
import { synthesize, BatchVAD, VoiceActivityDetector, StreamingTranscriber } from "@voiceci/voice";
import { CallerLLM } from "./caller-llm.js";
import { JudgeLLM } from "./judge-llm.js";
import { collectUntilEndOfTurn } from "../audio-tests/helpers.js";
import { computeAllMetrics } from "../metrics/index.js";
import { AdaptiveThreshold } from "./adaptive-threshold.js";
import { gradeAudioAnalysisMetrics, type TurnAudioData } from "../metrics/audio-analysis.js";

export async function runConversationTest(
  spec: ConversationTestSpec,
  channel: AudioChannel
): Promise<ConversationTestResult> {
  const startTime = performance.now();
  const transcript: ConversationTurn[] = [];
  const ttfbValues: number[] = [];

  const caller = new CallerLLM(spec.caller_prompt);
  const adaptiveThreshold = new AdaptiveThreshold({
    baseMs: spec.silence_threshold_ms ?? 800,
  });

  // Initialize VAD, batch VAD, streaming STT, and pre-generate first turn in parallel
  const turnVAD = new VoiceActivityDetector({ silenceThresholdMs: adaptiveThreshold.thresholdMs });
  const batchVAD = new BatchVAD();
  const transcriber = new StreamingTranscriber();

  const [, , , firstUtterance] = await Promise.all([
    turnVAD.init(),
    batchVAD.init(),
    transcriber.connect(),
    caller.nextUtterance(null, []),
  ]);

  // Pre-synthesize first turn TTS
  let prefetchedAudio: Buffer | null = null;
  let prefetchedText: string | null = firstUtterance;
  let prefetchedTtsMs = 0;
  if (firstUtterance) {
    const ttsStart = performance.now();
    prefetchedAudio = await synthesize(firstUtterance);
    prefetchedTtsMs = Math.round(performance.now() - ttsStart);
  }

  const turnAudioData: TurnAudioData[] = [];
  let agentText: string | null = null;

  try {
    for (let turn = 0; turn < spec.max_turns; turn++) {
      // Step 1: Caller LLM generates next utterance (skip on turn 0 — pre-generated)
      let callerText: string | null;
      let callerAudio: Buffer;
      let ttsMs: number;

      if (turn === 0 && prefetchedText !== null && prefetchedAudio !== null) {
        callerText = prefetchedText;
        callerAudio = prefetchedAudio;
        ttsMs = prefetchedTtsMs;
        prefetchedText = null;
        prefetchedAudio = null;
      } else {
        callerText = await caller.nextUtterance(agentText, transcript);
        if (callerText === null) break;

        const ttsStart = performance.now();
        callerAudio = await synthesize(callerText);
        ttsMs = Math.round(performance.now() - ttsStart);
      }

      const callerTimestamp = performance.now() - startTime;
      const audioDurationMs = Math.round((callerAudio.length / 2 / 24000) * 1000);

      transcript.push({
        role: "caller",
        text: callerText,
        timestamp_ms: Math.round(callerTimestamp),
        audio_duration_ms: audioDurationMs,
        tts_ms: ttsMs,
      });
      turnAudioData.push({ role: "caller", audioDurationMs });

      // Update VAD silence threshold for this turn (adaptive)
      turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;

      // Pipe agent audio to streaming STT during collection
      transcriber.resetForNextTurn();
      const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
      channel.on("audio", feedSTT);

      const sendTime = Date.now();
      channel.sendAudio(callerAudio);

      // Step 3: Collect agent response via VAD (reused instance)
      const { audio: agentAudio, stats } = await collectUntilEndOfTurn(
        channel,
        { timeoutMs: 15000, vad: turnVAD }
      );

      channel.off("audio", feedSTT);

      // Adapt threshold for next turn based on this turn's response cadence
      adaptiveThreshold.update(stats);

      const agentTimestamp = performance.now() - startTime;

      // Measure TTFB from first audio chunk timestamp
      let turnTtfb: number | undefined;
      if (agentAudio.length > 0 && stats.firstChunkAt !== null) {
        turnTtfb = Math.max(0, stats.firstChunkAt - sendTime);
        ttfbValues.push(turnTtfb);
      }

      // Step 4: Get streaming STT result + batch VAD analysis
      if (agentAudio.length > 0) {
        const sttStart = performance.now();
        const { text, confidence } = await transcriber.finalize();
        const sttMs = Math.round(performance.now() - sttStart);
        agentText = text;
        const agentAudioDurationMs = Math.round(
          (agentAudio.length / 2 / 24000) * 1000
        );

        // Batch VAD on agent audio for speech/silence segmentation
        const speechSegments = batchVAD.analyze(agentAudio);
        turnAudioData.push({
          role: "agent",
          audioDurationMs: agentAudioDurationMs,
          speechSegments,
        });

        transcript.push({
          role: "agent",
          text: agentText,
          timestamp_ms: Math.round(agentTimestamp),
          audio_duration_ms: agentAudioDurationMs,
          ttfb_ms: turnTtfb,
          stt_confidence: confidence,
          stt_ms: sttMs,
        });
      } else {
        agentText = "";
        turnAudioData.push({ role: "agent", audioDurationMs: 0 });
        transcript.push({
          role: "agent",
          text: "",
          timestamp_ms: Math.round(agentTimestamp),
          ttfb_ms: turnTtfb,
        });
      }
    }

    // Step 6: Collect tool call data from the channel (if supported)
    const observedToolCalls: ObservedToolCall[] = await channel.getCallData?.() ?? [];
    if (observedToolCalls.length > 0) {
      console.log(`    Collected ${observedToolCalls.length} tool call(s) from channel`);
    }

    // Step 7: Judge evaluates transcript + tool calls in parallel
    const judge = new JudgeLLM();
    const judgePromises: Promise<unknown>[] = [
      judge.evaluate(transcript, spec.eval),
      judge.evaluateAllBehavioral(transcript),
    ];

    // Evaluate tool call criteria if provided and tool call data exists
    const hasToolCallEval = spec.tool_call_eval && spec.tool_call_eval.length > 0;
    if (hasToolCallEval && observedToolCalls.length > 0) {
      judgePromises.push(
        judge.evaluateToolCalls(transcript, observedToolCalls, spec.tool_call_eval!),
      );
    }

    const [evalResults, behavioral, toolCallEvalResults] = (await Promise.all(judgePromises)) as [
      Awaited<ReturnType<typeof judge.evaluate>>,
      Awaited<ReturnType<typeof judge.evaluateAllBehavioral>>,
      Awaited<ReturnType<typeof judge.evaluateToolCalls>> | undefined,
    ];

    // Compute deep metrics (instant — pure functions)
    const totalDurationMs = Math.round(performance.now() - startTime);
    const meanTtfb =
      ttfbValues.length > 0
        ? Math.round(ttfbValues.reduce((a, b) => a + b, 0) / ttfbValues.length)
        : 0;

    const { transcript: transcriptMetrics, latency, talk_ratio, audio_analysis, harness_overhead } = computeAllMetrics(transcript, turnAudioData);

    // Compute tool call metrics
    let toolCallMetrics: ToolCallMetrics | undefined;
    if (observedToolCalls.length > 0) {
      const successful = observedToolCalls.filter((tc) => tc.successful === true).length;
      const failed = observedToolCalls.filter((tc) => tc.successful === false).length;
      const latencies = observedToolCalls
        .map((tc) => tc.latency_ms)
        .filter((l): l is number => l != null);
      const meanLatency =
        latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : undefined;
      const names = [...new Set(observedToolCalls.map((tc) => tc.name))];

      toolCallMetrics = {
        total: observedToolCalls.length,
        successful,
        failed,
        mean_latency_ms: meanLatency,
        names,
      };
    }

    // Grade audio analysis metrics (informational warnings)
    const audioAnalysisWarnings = audio_analysis
      ? gradeAudioAnalysisMetrics(audio_analysis)
      : undefined;

    const metrics: ConversationMetrics = {
      turns: transcript.length,
      mean_ttfb_ms: meanTtfb,
      total_duration_ms: totalDurationMs,
      talk_ratio,
      transcript: transcriptMetrics,
      latency,
      behavioral,
      tool_calls: toolCallMetrics,
      audio_analysis,
      audio_analysis_warnings: audioAnalysisWarnings?.length ? audioAnalysisWarnings : undefined,
      harness_overhead,
    };

    // Status: pass only if all relevant eval questions passed (both regular and tool call evals)
    const relevantResults = evalResults.filter((r) => r.relevant);
    const allEvalsPassed =
      relevantResults.length > 0 && relevantResults.every((r) => r.passed);

    const relevantToolCallResults = (toolCallEvalResults ?? []).filter((r) => r.relevant);
    const allToolCallEvalsPassed =
      relevantToolCallResults.length === 0 || relevantToolCallResults.every((r) => r.passed);

    const allPassed = allEvalsPassed && allToolCallEvalsPassed;

    return {
      name: spec.name,
      caller_prompt: spec.caller_prompt,
      status: allPassed ? "pass" : "fail",
      transcript,
      eval_results: evalResults,
      tool_call_eval_results: toolCallEvalResults,
      observed_tool_calls: observedToolCalls.length > 0 ? observedToolCalls : undefined,
      duration_ms: totalDurationMs,
      metrics,
    };
  } finally {
    transcriber.close();
    turnVAD.destroy();
    batchVAD.destroy();
  }
}
