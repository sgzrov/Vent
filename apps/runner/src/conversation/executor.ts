/**
 * Conversation test executor — runs a full dynamic conversation loop.
 *
 * Flow:
 * 1. Caller LLM generates text from persona prompt
 * 2. TTS → send audio to agent via AudioChannel
 * 3. Collect agent audio (VAD for end-of-turn)
 * 4. STT → text back to caller LLM
 * 5. Repeat until max_turns or caller says [END]
 * 6. Compute metrics (latency, audio, tool calls, prosody)
 */

import type { AudioChannel } from "@vent/adapters";
import type {
  ConversationTestSpec,
  ConversationTestResult,
  ConversationTurn,
  ConversationMetrics,
  ObservedToolCall,
  ToolCallMetrics,
  AudioActionResult,
  ComponentLatency,
  ComponentLatencyMetrics,
} from "@vent/shared";
import { synthesize, TTSSession, BatchVAD, VoiceActivityDetector, StreamingTranscriber, applyEffects, resolveAccentVoiceId, resolveLanguageVoiceId, analyzeAudioQuality, type AudioQualityMetrics } from "@vent/voice";
import { CallerLLM } from "./caller-llm.js";
import { executeAudioAction, mixCallerWithNoise } from "./audio-actions.js";
import { collectUntilEndOfTurn, linearRegressionSlope } from "../audio-tests/helpers.js";
import { computeAllMetrics } from "../metrics/index.js";
import { analyzeProsody } from "../metrics/prosody.js";
import { AdaptiveThreshold } from "./adaptive-threshold.js";
import { gradeAudioAnalysisMetrics, type TurnAudioData } from "../metrics/audio-analysis.js";

export async function runConversationTest(
  spec: ConversationTestSpec,
  channel: AudioChannel
): Promise<ConversationTestResult> {
  const startTime = performance.now();
  const transcript: ConversationTurn[] = [];
  const ttfbValues: number[] = [];
  const ttfwValues: number[] = [];

  const language = spec.language;
  const caller = new CallerLLM(spec.caller_prompt, spec.persona, language);
  const adaptiveThreshold = new AdaptiveThreshold({
    baseMs: spec.silence_threshold_ms ?? 800,
  });

  // Initialize VAD, batch VAD, streaming STT, and pre-generate first turn in parallel
  const turnVAD = new VoiceActivityDetector({ silenceThresholdMs: adaptiveThreshold.thresholdMs });
  const batchVAD = new BatchVAD();
  const transcriber = new StreamingTranscriber(language ? { language } : undefined);

  const [, , , firstUtterance] = await Promise.all([
    turnVAD.init(),
    batchVAD.init(),
    transcriber.connect(),
    caller.nextUtterance(null, []),
  ]);

  // Resolve accent → TTS voice ID (accent takes priority over language default)
  const ttsVoiceId = spec.caller_audio?.accent
    ? resolveAccentVoiceId(spec.caller_audio.accent)
    : language
      ? resolveLanguageVoiceId(language)
      : undefined;
  const ttsOpts = ttsVoiceId ? { voiceId: ttsVoiceId } : undefined;

  // Persistent TTS session — one WebSocket for all turns (avoids REST rate limit)
  const ttsSession = new TTSSession(ttsOpts);
  await ttsSession.connect();

  // Pre-synthesize first turn TTS
  let prefetchedAudio: Buffer | null = null;
  let prefetchedText: string | null = firstUtterance;
  let prefetchedTtsMs = 0;
  if (firstUtterance) {
    const ttsStart = performance.now();
    prefetchedAudio = await ttsSession.synthesize(firstUtterance);
    if (spec.caller_audio) prefetchedAudio = applyEffects(prefetchedAudio, spec.caller_audio);
    prefetchedTtsMs = Math.round(performance.now() - ttsStart);
  }

  const turnAudioData: TurnAudioData[] = [];
  const agentAudioBuffers: Buffer[] = [];
  const turnSignalQualities: AudioQualityMetrics[] = [];
  const audioActionResults: AudioActionResult[] = [];
  let agentText: string | null = null;

  // AEC gap: LiveKit agents suppress incoming audio for ~500ms after their
  // own speech ends (Acoustic Echo Cancellation warmup). Track when the agent
  // last finished speaking so we can ensure a minimum gap before sendAudio.
  const AEC_GAP_MS = 500;
  let lastAgentDoneAt = 0;

  const ensureAecGap = async () => {
    if (lastAgentDoneAt === 0) return;
    const elapsed = Date.now() - lastAgentDoneAt;
    if (elapsed < AEC_GAP_MS) {
      await new Promise((r) => setTimeout(r, AEC_GAP_MS - elapsed));
    }
  };

  try {
    // ── Agent greeting capture ──────────────────────────────
    // Voice agents always greet first. Wait for the agent to finish
    // speaking, capture the greeting, and let CallerLLM respond naturally.
    // Early audio buffered in BaseAudioChannel is flushed here.
    {
      const greetingVAD = new VoiceActivityDetector({ silenceThresholdMs: 1500 });
      await greetingVAD.init();

      const greetingResult = await collectUntilEndOfTurn(channel, {
        timeoutMs: 30000,
        vad: greetingVAD,
      });
      greetingVAD.destroy();

      if (greetingResult.stats.speechOnsetAt !== null && greetingResult.audio.length > 4800) {
        // Agent spoke a greeting — transcribe it and use as first agent turn
        transcriber.resetForNextTurn();
        transcriber.feedAudio(greetingResult.audio);
        const { text: greetingText } = await transcriber.finalize();

        if (greetingText) {
          console.log(`    Agent greeting: "${greetingText.slice(0, 80)}..."`);
          agentText = greetingText;

          const greetingTimestamp = performance.now() - startTime;
          const greetingDurationMs = Math.round((greetingResult.audio.length / 2 / 24000) * 1000);
          turnAudioData.push({ role: "agent", audioDurationMs: greetingDurationMs });
          transcript.push({
            role: "agent",
            text: greetingText,
            timestamp_ms: Math.round(greetingTimestamp),
            audio_duration_ms: greetingDurationMs,
          });

          // Discard the pre-fetched first utterance — CallerLLM will now
          // generate a response to the greeting instead of a cold open.
          prefetchedText = null;
          prefetchedAudio = null;
        }
      } else if (greetingResult.timedOut) {
        throw new Error("Agent connected but did not speak within 30s");
      }
      lastAgentDoneAt = Date.now();
    }

    for (let turn = 0; turn < spec.max_turns; turn++) {
      // Check for audio action at this turn (silence, split_sentence skip CallerLLM)
      const audioAction = spec.audio_actions?.find((a) => a.at_turn === turn);

      if (audioAction && (audioAction.action === "silence" || audioAction.action === "split_sentence")) {
        // These actions replace the caller utterance entirely
        const callerTimestamp = performance.now() - startTime;
        const actionLabel = audioAction.action === "silence"
          ? `[silence ${audioAction.duration_ms ?? 8000}ms]`
          : `[split: "${audioAction.split?.part_a}" ... "${audioAction.split?.part_b}"]`;

        transcript.push({
          role: "caller",
          text: actionLabel,
          timestamp_ms: Math.round(callerTimestamp),
        });
        turnAudioData.push({ role: "caller", audioDurationMs: 0 });

        turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;

        const { result: actionResult, agentText: actionAgentText } = await executeAudioAction(
          audioAction,
          { channel, vad: turnVAD, transcriber, callerAudioEffects: spec.caller_audio, ttsVoiceId, ttsSession },
        );
        audioActionResults.push(actionResult);
        agentText = actionAgentText;
        lastAgentDoneAt = Date.now();

        const agentTimestamp = performance.now() - startTime;
        turnAudioData.push({ role: "agent", audioDurationMs: 0 });
        transcript.push({
          role: "agent",
          text: actionAgentText,
          timestamp_ms: Math.round(agentTimestamp),
        });
        continue;
      }

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
        callerAudio = await ttsSession.synthesize(callerText);
        if (spec.caller_audio) callerAudio = applyEffects(callerAudio, spec.caller_audio);
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

      // Handle noise_on_caller: mix noise into caller audio before sending
      if (audioAction?.action === "noise_on_caller") {
        callerAudio = mixCallerWithNoise(
          callerAudio,
          audioAction.noise_type ?? "babble",
          audioAction.snr_db ?? 10,
        );
      }

      // Pipe agent audio to streaming STT during collection
      transcriber.resetForNextTurn();
      const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
      channel.on("audio", feedSTT);

      // Ensure AEC suppression window has passed before sending caller audio
      await ensureAecGap();
      const sendTime = Date.now();
      await channel.sendAudio(callerAudio);

      // Handle interrupt action: wait for agent speech, then send interrupt
      if (audioAction?.action === "interrupt") {
        const { result: actionResult, agentText: actionAgentText } = await executeAudioAction(
          audioAction,
          { channel, vad: turnVAD, transcriber, callerAudioEffects: spec.caller_audio, ttsVoiceId, ttsSession },
        );
        audioActionResults.push(actionResult);
        channel.off("audio", feedSTT);

        agentText = actionAgentText;
        lastAgentDoneAt = Date.now();
        const agentTimestamp = performance.now() - startTime;
        turnAudioData.push({ role: "agent", audioDurationMs: 0 });
        transcript.push({
          role: "agent",
          text: actionAgentText,
          timestamp_ms: Math.round(agentTimestamp),
        });
        continue;
      }

      // Handle inject_noise action: send noise during agent speech
      if (audioAction?.action === "inject_noise") {
        const { result: actionResult, agentText: actionAgentText } = await executeAudioAction(
          audioAction,
          { channel, vad: turnVAD, transcriber, callerAudioEffects: spec.caller_audio, ttsVoiceId, ttsSession },
        );
        audioActionResults.push(actionResult);
        channel.off("audio", feedSTT);

        agentText = actionAgentText;
        lastAgentDoneAt = Date.now();
        const agentTimestamp = performance.now() - startTime;
        turnAudioData.push({ role: "agent", audioDurationMs: 0 });
        transcript.push({
          role: "agent",
          text: actionAgentText,
          timestamp_ms: Math.round(agentTimestamp),
        });
        continue;
      }

      // Step 3: Collect agent response via VAD (reused instance)
      // 30s timeout: LiveKit sendAudio is fire-and-forget with real-time pacing,
      // so frames take seconds to deliver. The agent also needs processing time
      // (STT → LLM → TTS) before responding.
      const { audio: agentAudio, stats, timedOut } = await collectUntilEndOfTurn(
        channel,
        { timeoutMs: 30000, vad: turnVAD }
      );
      lastAgentDoneAt = Date.now();

      channel.off("audio", feedSTT);

      // Fail fast: if no speech detected within timeout, agent has stopped responding
      if (timedOut && stats.speechOnsetAt === null) {
        throw new Error(
          `Agent stopped responding — no speech detected for 30s after turn ${turn + 1}. ` +
          `This may indicate the agent's backend (STT/LLM/TTS) is overwhelmed or rate-limited.`
        );
      }

      // Adapt threshold for next turn based on this turn's response cadence
      adaptiveThreshold.update(stats);

      // Record noise_on_caller action result after normal response collection
      if (audioAction?.action === "noise_on_caller") {
        audioActionResults.push({
          at_turn: audioAction.at_turn,
          action: "noise_on_caller",
          metrics: {},
          transcriptions: { agent_response: null }, // filled below after STT
        });
      }

      const agentTimestamp = performance.now() - startTime;

      // Measure TTFB (first audio byte) and TTFW (first speech via VAD)
      let turnTtfb: number | undefined;
      let turnTtfw: number | undefined;
      let turnSilencePad: number | undefined;
      if (agentAudio.length > 0 && stats.firstChunkAt !== null) {
        turnTtfb = Math.max(0, stats.firstChunkAt - sendTime);
        ttfbValues.push(turnTtfb);

        if (stats.speechOnsetAt !== null) {
          turnTtfw = Math.max(0, stats.speechOnsetAt - sendTime);
          ttfwValues.push(turnTtfw);
          turnSilencePad = Math.max(0, turnTtfw - turnTtfb);
        }
      }

      // Step 4: Get streaming STT result + batch VAD analysis
      if (agentAudio.length > 0) {
        const sttStart = performance.now();
        let { text, confidence } = await transcriber.finalize();
        const sttMs = Math.round(performance.now() - sttStart);

        // Fallback: use real-time platform transcript when STT finds nothing
        // (e.g. Bland sends agent text via control messages but binary audio is sparse)
        if (!text && channel.consumeAgentText) {
          const platformText = channel.consumeAgentText();
          if (platformText) {
            text = platformText;
            confidence = 1;
          }
        } else {
          // Consume and discard — keep buffer from growing across turns
          channel.consumeAgentText?.();
        }

        agentText = text;

        // Update noise_on_caller action result with actual transcription
        if (audioAction?.action === "noise_on_caller") {
          const lastAction = audioActionResults[audioActionResults.length - 1];
          if (lastAction?.action === "noise_on_caller" && lastAction.transcriptions) {
            lastAction.transcriptions.agent_response = text || null;
          }
        }
        const agentAudioDurationMs = Math.round(
          (agentAudio.length / 2 / 24000) * 1000
        );

        // Batch VAD on agent audio for speech/silence segmentation
        const speechSegments = batchVAD.analyze(agentAudio);
        if (spec.prosody) agentAudioBuffers.push(Buffer.from(agentAudio));
        // Signal quality analysis on raw audio buffer
        turnSignalQualities.push(analyzeAudioQuality(agentAudio, speechSegments));
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
          ttfw_ms: turnTtfw,
          silence_pad_ms: turnSilencePad,
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
          ttfw_ms: turnTtfw,
          silence_pad_ms: turnSilencePad,
        });
      }
    }

    // Step 6: Collect tool call data from the channel (if supported)
    const observedToolCalls: ObservedToolCall[] = await channel.getCallData?.() ?? [];
    if (observedToolCalls.length > 0) {
      console.log(`    Collected ${observedToolCalls.length} tool call(s) from channel`);
      // Match each tool call to the agent turn it belongs to by timestamp
      const agentTurns = transcript
        .map((t, i) => ({ timestamp_ms: t.timestamp_ms, index: i }))
        .filter((_, i) => transcript[i]!.role === "agent");
      for (const tc of observedToolCalls) {
        if (tc.timestamp_ms == null) continue;
        let matched = 0;
        for (const at of agentTurns) {
          if (at.timestamp_ms <= tc.timestamp_ms) matched = at.index;
          else break;
        }
        tc.turn_index = matched;
      }
    }

    // Step 7: Prosody analysis (if enabled)
    const prosodyResult = spec.prosody ? await analyzeProsody(agentAudioBuffers) : null;

    // Compute deep metrics (instant — pure functions)
    const totalDurationMs = Math.round(performance.now() - startTime);
    const meanTtfb =
      ttfbValues.length > 0
        ? Math.round(ttfbValues.reduce((a, b) => a + b, 0) / ttfbValues.length)
        : 0;
    const meanTtfw =
      ttfwValues.length > 0
        ? Math.round(ttfwValues.reduce((a, b) => a + b, 0) / ttfwValues.length)
        : undefined;

    const { transcript: transcriptMetrics, latency, audio_analysis, harness_overhead } = computeAllMetrics(transcript, turnAudioData, channel.stats.connectLatencyMs);

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

    // Step 8: Collect platform component latency (STT/LLM/TTS per turn)
    const rawComponentTimings = channel.getComponentTimings?.() ?? [];
    let componentLatencyMetrics: ComponentLatencyMetrics | undefined;
    if (rawComponentTimings.length > 0) {
      // Merge per-turn component latency into transcript turns
      for (let i = 0; i < rawComponentTimings.length && i < transcript.length; i++) {
        const timing = rawComponentTimings[i];
        if (timing && (timing.stt_ms != null || timing.llm_ms != null || timing.tts_ms != null)) {
          // Find the corresponding agent turn (component latency maps to agent responses)
          const agentTurnIdx = transcript.findIndex((t, idx) => idx > 0 && t.role === "agent" && Math.floor(idx / 2) === i);
          if (agentTurnIdx >= 0) {
            transcript[agentTurnIdx]!.component_latency = timing;
          }
        }
      }

      // Compute aggregate component latency metrics
      const sttValues = rawComponentTimings.map((t: ComponentLatency) => t.stt_ms).filter((v: number | undefined): v is number => v != null);
      const llmValues = rawComponentTimings.map((t: ComponentLatency) => t.llm_ms).filter((v: number | undefined): v is number => v != null);
      const ttsValues = rawComponentTimings.map((t: ComponentLatency) => t.tts_ms).filter((v: number | undefined): v is number => v != null);

      const mean = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : undefined;
      const p95 = (arr: number[]) => {
        if (arr.length === 0) return undefined;
        const sorted = [...arr].sort((a, b) => a - b);
        return Math.round(sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)]!);
      };

      const meanStt = mean(sttValues);
      const meanLlm = mean(llmValues);
      const meanTts = mean(ttsValues);

      // Determine bottleneck from mean values
      let bottleneck: "stt" | "llm" | "tts" | undefined;
      if (meanStt != null && meanLlm != null && meanTts != null) {
        const max = Math.max(meanStt, meanLlm, meanTts);
        if (max === meanLlm) bottleneck = "llm";
        else if (max === meanStt) bottleneck = "stt";
        else bottleneck = "tts";
      }

      componentLatencyMetrics = {
        per_turn: rawComponentTimings,
        mean_stt_ms: meanStt,
        mean_llm_ms: meanLlm,
        mean_tts_ms: meanTts,
        p95_stt_ms: p95(sttValues),
        p95_llm_ms: p95(llmValues),
        p95_tts_ms: p95(ttsValues),
        bottleneck,
      };
      console.log(`    Component latency: STT=${meanStt ?? "?"}ms LLM=${meanLlm ?? "?"}ms TTS=${meanTts ?? "?"}ms [bottleneck: ${bottleneck ?? "unknown"}]`);
    }

    // Step 8b: Merge platform STT transcripts for cross-referencing
    const platformTranscripts = channel.getTranscripts?.() ?? [];
    for (const pt of platformTranscripts) {
      // Platform transcripts map to caller turns (user speech → platform STT)
      const callerTurns = transcript.filter((t) => t.role === "caller");
      if (pt.turnIndex < callerTurns.length) {
        callerTurns[pt.turnIndex]!.platform_transcript = pt.text;
      }
    }

    // Step 9: Collect platform call metadata (cost, ended reason, recording, analysis)
    const callMetadata = await channel.getCallMetadata?.() ?? null;
    if (callMetadata) {
      console.log(`    Call metadata: ended_reason=${callMetadata.ended_reason ?? "unknown"}, cost=$${callMetadata.cost_usd?.toFixed(4) ?? "n/a"}`);
    }

    // Grade audio analysis metrics (informational warnings)
    const audioAnalysisWarnings = audio_analysis
      ? gradeAudioAnalysisMetrics(audio_analysis)
      : undefined;

    // Aggregate signal quality across turns
    const signalQuality = turnSignalQualities.length > 0
      ? {
          mean_snr_db: Math.round(
            turnSignalQualities.reduce((a, q) => a + q.estimated_snr_db, 0) / turnSignalQualities.length * 10,
          ) / 10,
          max_clipping_ratio: Math.max(...turnSignalQualities.map((q) => q.clipping_ratio)),
          energy_consistency: Math.round(
            turnSignalQualities.reduce((a, q) => a + q.energy_consistency, 0) / turnSignalQualities.length * 1000,
          ) / 1000,
          sudden_drops: turnSignalQualities.reduce((a, q) => a + q.sudden_drops, 0),
          sudden_spikes: turnSignalQualities.reduce((a, q) => a + q.sudden_spikes, 0),
          clean_edges: turnSignalQualities.every((q) => q.clean_start && q.clean_end),
          f0_hz: Math.round(
            turnSignalQualities.reduce((a, q) => a + q.f0_hz, 0) / turnSignalQualities.length,
          ),
        }
      : undefined;

    // Compute TTFB drift slope
    if (latency && ttfbValues.length >= 2) {
      latency.drift_slope_ms_per_turn =
        Math.round(linearRegressionSlope(ttfbValues) * 100) / 100;
    }

    const metrics: ConversationMetrics = {
      mean_ttfb_ms: meanTtfb,
      mean_ttfw_ms: meanTtfw,
      transcript: transcriptMetrics,
      latency,
      signal_quality: signalQuality,
      tool_calls: toolCallMetrics,
      audio_analysis,
      audio_analysis_warnings: audioAnalysisWarnings?.length ? audioAnalysisWarnings : undefined,
      prosody: prosodyResult?.metrics,
      prosody_warnings: prosodyResult?.warnings?.length ? prosodyResult.warnings : undefined,
      harness_overhead,
      component_latency: componentLatencyMetrics,
    };

    return {
      name: spec.name,
      caller_prompt: spec.caller_prompt,
      status: "completed",
      transcript,

      observed_tool_calls: observedToolCalls.length > 0 ? observedToolCalls : undefined,
      audio_action_results: audioActionResults.length > 0 ? audioActionResults : undefined,
      duration_ms: totalDurationMs,
      metrics,
      call_metadata: callMetadata ?? undefined,
    };
  } finally {
    await ttsSession.close();
    transcriber.close();
    turnVAD.destroy();
    batchVAD.destroy();
  }
}
