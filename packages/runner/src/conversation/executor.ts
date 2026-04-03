/**
 * Conversation call executor — runs a full dynamic conversation loop.
 *
 * Flow:
 * 1. Caller LLM generates text from persona prompt
 * 2. TTS → send audio to agent via AudioChannel
 * 3. Collect agent audio (VAD for end-of-turn)
 * 4. STT → text back to caller LLM
 * 5. Repeat until max_turns or the caller decides the conversation is over
 * 6. Compute metrics (latency, audio, tool calls, prosody)
 */

import type { AudioChannel } from "@vent/adapters";
import type {
  ConversationCallSpec,
  ConversationCallResult,
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
import { executeAudioAction, mixCallerWithNoise, collectForDurationSafe } from "./audio-actions.js";
import { collectUntilEndOfTurn, linearRegressionSlope } from "../audio-tests/helpers.js";
import { computeAllMetrics } from "../metrics/index.js";
import { analyzeProsody } from "../metrics/prosody.js";
import { AdaptiveThreshold } from "./adaptive-threshold.js";
import { gradeAudioAnalysisMetrics, type TurnAudioData } from "../metrics/audio-analysis.js";

function summarizeDebugText(text: string | null | undefined, maxChars = 96): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function prepareCallerSpeechText(channel: AudioChannel, text: string): string {
  return (channel.normalizeCallerTextForSpeech?.(text) ?? text)
    .replace(/\s+/g, " ")
    .trim();
}

function sinceStartMs(startTime: number): number {
  return Math.round(performance.now() - startTime);
}

function recordTurnAudio(
  turnAudioData: TurnAudioData[],
  audioStartTimestampMs: number,
  data: Omit<TurnAudioData, "audioStartTimestampMs">,
): void {
  turnAudioData.push({
    ...data,
    audioStartTimestampMs: Math.round(audioStartTimestampMs),
  });
}

export async function runConversationCall(
  spec: ConversationCallSpec,
  channel: AudioChannel,
): Promise<ConversationCallResult> {
  const startTime = performance.now();
  const transcript: ConversationTurn[] = [];
  const ttfbValues: number[] = [];
  const ttfwValues: number[] = [];

  const language = spec.language;
  const caller = new CallerLLM(spec.caller_prompt, spec.persona, language);
  const adaptiveThreshold = new AdaptiveThreshold({
    baseMs: spec.silence_threshold_ms ?? channel.preferredSilenceThresholdMs ?? 400,
  });

  // Initialize VAD, batch VAD, and streaming STT up front.
  // The caller's first turn is generated only after the real greeting turn is collected.
  const turnVAD = new VoiceActivityDetector({ silenceThresholdMs: adaptiveThreshold.thresholdMs });
  const batchVAD = new BatchVAD();
  const transcriber = new StreamingTranscriber(language ? { language } : undefined);

  await Promise.all([
    turnVAD.init(),
    batchVAD.init(),
    transcriber.connect(),
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

  const openingSpeaker = await channel.getOpeningSpeaker?.() ?? "agent";
  const maxCallDurationSeconds = await channel.getMaxCallDurationSeconds?.() ?? null;
  const callDeadlineMs = maxCallDurationSeconds != null
    ? startTime + Math.max(0, maxCallDurationSeconds * 1000 - 1000)
    : null;
  const collectGreetingFirst = openingSpeaker !== "caller";
  console.log(
    `    [opening] speaker=${openingSpeaker}` +
    (maxCallDurationSeconds != null ? ` maxDuration=${maxCallDurationSeconds}s` : "")
  );

  const remainingCallMs = (): number | null => {
    if (callDeadlineMs == null) return null;
    return Math.max(0, Math.floor(callDeadlineMs - performance.now()));
  };

  const resolveCollectionTimeoutMs = (defaultMs: number): number => {
    const remainingMs = remainingCallMs();
    if (remainingMs == null) return defaultMs;
    return Math.max(250, Math.min(defaultMs, remainingMs));
  };

  const canStartAnotherTurn = (minimumMs = 1500): boolean => {
    const remainingMs = remainingCallMs();
    return remainingMs == null || remainingMs > minimumMs;
  };

  const turnAudioData: TurnAudioData[] = [];
  const agentAudioBuffers: Buffer[] = [];
  const turnSignalQualities: AudioQualityMetrics[] = [];
  const audioActionResults: AudioActionResult[] = [];
  let agentText: string | null = null;

  const resolveAgentAudioStartTimestampMs = (
    turnEndTimestampMs: number,
    audioDurationMs: number,
    anchorTimestampMs?: number,
    ttfbMs?: number,
  ): number => {
    if (anchorTimestampMs != null && ttfbMs != null) {
      return Math.max(0, Math.round(anchorTimestampMs + ttfbMs));
    }
    return Math.max(0, Math.round(turnEndTimestampMs - audioDurationMs));
  };

  // Track channel disconnect — when the agent hangs up, the call ends naturally.
  let channelDisconnected = false;
  const safeDisconnect = async () => {
    if (channelDisconnected || !channel.connected) return;
    try {
      await channel.disconnect();
    } catch (err) {
      console.log(`    [end] Non-fatal disconnect error: ${(err as Error).message}`);
    } finally {
      channelDisconnected = true;
    }
  };
  channel.on("disconnected", () => {
    channelDisconnected = true;
    console.log(`    [end] Channel disconnected — agent ended the call`);
  });

  try {
    // For assistant-speaks-first platforms, turn -1 collects the agent greeting.
    // For caller-speaks-first platforms, we start directly at turn 0.
    for (let turn = collectGreetingFirst ? -1 : 0; turn < spec.max_turns; turn++) {
      if (channelDisconnected) break;
      if (turn >= 0 && !canStartAnotherTurn()) {
        console.log(`    [call-limit] maxDurationSeconds reached — stopping before turn=${turn}`);
        break;
      }
      // ── Greeting turn: just collect agent audio, no caller speech ──
      if (turn === -1) {
        const vadStart = performance.now();
        transcriber.resetForNextTurn();
        const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
        channel.on("audio", feedSTT);
        console.log(`    [opening] collect_start t=${sinceStartMs(startTime)}ms`);

        turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;
        const { audio: agentAudio, stats, timedOut } = await collectUntilEndOfTurn(
          channel,
          {
            timeoutMs: resolveCollectionTimeoutMs(30000),
            vad: turnVAD,
            preferPlatformEOT: !!channel.hasPlatformEndOfTurn,
            debugLabel: "opening",
          }
        );
        channel.off("audio", feedSTT);
        console.log(
          `    [opening] collect_end t=${sinceStartMs(startTime)}ms bytes=${agentAudio.length} ` +
          `timedOut=${timedOut} speechOnset=${stats.speechOnsetAt !== null}`
        );

        if (timedOut && stats.speechOnsetAt === null) {
          throw new Error("Agent connected but did not speak within 30s");
        }

        let greetingText = "";
        let greetingSttMs = 0;
        if (stats.speechOnsetAt !== null && agentAudio.length > 4800) {
          const sttStart = performance.now();
          const { text } = await transcriber.finalize();
          greetingSttMs = Math.round(performance.now() - sttStart);

          if (!text && channel.consumeAgentText) {
            const platformText = channel.consumeAgentText();
            if (platformText) greetingText = platformText;
          } else {
            greetingText = text;
            channel.consumeAgentText?.();
          }
        } else {
          channel.consumeAgentText?.();
        }

        if (greetingText) {
          const vadMs = Math.round(performance.now() - vadStart);
          console.log(`    Agent greeting: "${greetingText.slice(0, 80)}..."`);
          console.log(`[turn-timing] greeting vad_collect=${vadMs}ms stt=${greetingSttMs}ms`);
          console.log(`    [opening] resolved t=${sinceStartMs(startTime)}ms`);
          agentText = greetingText;

          const agentTimestamp = performance.now() - startTime;
          const audioDurationMs = Math.round((agentAudio.length / 2 / 24000) * 1000);
          const speechSegments = batchVAD.analyze(agentAudio);
          if (spec.prosody) agentAudioBuffers.push(Buffer.from(agentAudio));
          turnSignalQualities.push(analyzeAudioQuality(agentAudio, speechSegments));
          recordTurnAudio(turnAudioData, resolveAgentAudioStartTimestampMs(agentTimestamp, audioDurationMs), {
            role: "agent",
            audioDurationMs,
            speechSegments,
          });
          transcript.push({
            role: "agent",
            text: greetingText,
            timestamp_ms: Math.round(agentTimestamp),
            audio_duration_ms: audioDurationMs,
            stt_ms: greetingSttMs,
          });
        }

        adaptiveThreshold.update(stats);
        continue;
      }
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
        recordTurnAudio(turnAudioData, callerTimestamp, {
          role: "caller",
          audioDurationMs: 0,
          callerDecisionMode: undefined,
        });

        turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;

        const { result: actionResult, agentText: actionAgentText } = await executeAudioAction(
          audioAction,
          { channel, vad: turnVAD, transcriber, callerAudioEffects: spec.caller_audio, ttsVoiceId, ttsSession },
        );
        audioActionResults.push(actionResult);
        agentText = actionAgentText;
  
        const agentTimestamp = performance.now() - startTime;
        recordTurnAudio(turnAudioData, agentTimestamp, {
          role: "agent",
          audioDurationMs: 0,
          speechSegments: [],
        });
        transcript.push({
          role: "agent",
          text: actionAgentText,
          timestamp_ms: Math.round(agentTimestamp),
        });
        continue;
      }

      // Step 1: Caller LLM generates the next full utterance.
      let callerText: string | null;
      let ttsMs = 0;
      const turnPipelineStart = performance.now();

      // Update VAD silence threshold for this turn (adaptive)
      turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;

      // Pipe agent audio to streaming STT during collection
      transcriber.resetForNextTurn();
      const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
      channel.on("audio", feedSTT);

      let sendTime: number;

      let callerAudio: Buffer | null = null;
      let callerDecision: Awaited<ReturnType<CallerLLM["nextUtterance"]>>;
      let llmMs: number;
      let spokenCallerText: string | null = null;
      const llmStart = performance.now();
      callerDecision = await caller.nextUtterance(agentText, transcript);
      llmMs = Math.round(performance.now() - llmStart);

      const shouldStopAfterAgentReply = callerDecision?.mode === "closing";

      if (!callerDecision || callerDecision.mode === "end_now") {
        channel.off("audio", feedSTT);
        break;
      }

      if (callerDecision.mode === "wait") {
        console.log(`[turn-decision] turn=${turn} caller=wait caller_llm=${llmMs}ms`);

        const vadStart = performance.now();
        const { audio: agentAudio, stats, timedOut } = await collectUntilEndOfTurn(
          channel,
          {
            timeoutMs: resolveCollectionTimeoutMs(30000),
            vad: turnVAD,
            preferPlatformEOT: !!channel.hasPlatformEndOfTurn,
            debugLabel: `turn-${turn}-wait`,
          }
        );
        const vadMs = Math.round(performance.now() - vadStart);
        console.log(
          `[turn-collect] turn=${turn} caller=wait bytes=${agentAudio.length} timedOut=${timedOut} ` +
          `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null} ` +
          `speechSegments=${stats.speechSegments} totalSpeechMs=${stats.totalSpeechMs}`
        );

        channel.off("audio", feedSTT);

        if (timedOut && stats.speechOnsetAt === null) {
          throw new Error(
            `Agent stopped responding — no speech detected for 30s after turn ${turn + 1}. ` +
            `This may indicate the agent's backend (STT/LLM/TTS) is overwhelmed or rate-limited.`
          );
        }

        adaptiveThreshold.update(stats);

        const agentTimestamp = performance.now() - startTime;

        if (agentAudio.length > 0) {
          const sttStart = performance.now();
          let { text, confidence } = await transcriber.finalize();
          const sttMs = Math.round(performance.now() - sttStart);
          let textSource = text ? "stt" : "empty";

          if (!text && channel.consumeAgentText) {
            const platformText = channel.consumeAgentText();
            if (platformText) {
              text = platformText;
              confidence = 1;
              textSource = "platform";
            }
          } else {
            channel.consumeAgentText?.();
          }

          agentText = text;

          const totalPipelineMs = Math.round(performance.now() - turnPipelineStart);
          console.log(`[turn-timing] turn=${turn} caller=wait vad_collect=${vadMs}ms stt=${sttMs}ms total_pipeline=${totalPipelineMs}ms threshold=${adaptiveThreshold.thresholdMs}ms`);
          console.log(
            `[turn-text] turn=${turn} caller=wait source=${textSource} chars=${text?.length ?? 0} ` +
            `text="${summarizeDebugText(agentText)}"`
          );

          const agentAudioDurationMs = Math.round(
            (agentAudio.length / 2 / 24000) * 1000
          );
          const speechSegments = batchVAD.analyze(agentAudio);
          if (spec.prosody) agentAudioBuffers.push(Buffer.from(agentAudio));
          turnSignalQualities.push(analyzeAudioQuality(agentAudio, speechSegments));
          recordTurnAudio(turnAudioData, resolveAgentAudioStartTimestampMs(agentTimestamp, agentAudioDurationMs), {
            role: "agent",
            audioDurationMs: agentAudioDurationMs,
            speechSegments,
          });

          transcript.push({
            role: "agent",
            text: agentText,
            timestamp_ms: Math.round(agentTimestamp),
            caller_decision_mode: "wait",
            audio_duration_ms: agentAudioDurationMs,
            stt_confidence: confidence,
            stt_ms: sttMs,
          });
          if (shouldStopAfterAgentReply) break;
        } else {
          agentText = "";
          console.log(
            `[turn-text] turn=${turn} caller=wait source=empty-audio chars=0 timedOut=${timedOut} ` +
            `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null}`
          );
          recordTurnAudio(turnAudioData, agentTimestamp, {
            role: "agent",
            audioDurationMs: 0,
            speechSegments: [],
          });
          transcript.push({
            role: "agent",
            text: "",
            timestamp_ms: Math.round(agentTimestamp),
            caller_decision_mode: "wait",
          });
          if (shouldStopAfterAgentReply) break;
        }
        continue;
      }

      callerText = callerDecision.text;
      spokenCallerText = prepareCallerSpeechText(channel, callerText);
      const emittedCallerText = spokenCallerText ?? callerText;
      if (spokenCallerText !== callerText) {
        console.log(
          `[caller-tts] turn=${turn} normalized original="${summarizeDebugText(callerText)}" ` +
          `spoken="${summarizeDebugText(spokenCallerText)}"`
        );
      }
      console.log(
        `    [caller] turn=${turn} decision=${callerDecision.mode} t=${sinceStartMs(startTime)}ms ` +
        `text="${summarizeDebugText(emittedCallerText)}"`
      );

      const ttsStart = performance.now();
      callerAudio = await ttsSession.synthesize(emittedCallerText);
      if (spec.caller_audio) callerAudio = applyEffects(callerAudio, spec.caller_audio);
      ttsMs = Math.round(performance.now() - ttsStart);

      if (!callerAudio) {
        channel.off("audio", feedSTT);
        throw new Error(`Caller audio was not prepared for turn ${turn}`);
      }

      console.log(`[turn-timing] turn=${turn} caller_llm=${llmMs}ms tts=${ttsMs}ms`);

      if (channelDisconnected || !channel.connected) {
        if (turn === 0 && collectGreetingFirst) {
          console.log(
            `    [opening-error] caller turn skipped because the channel disconnected before turn 0 send`
          );
        }
        break;
      }

      const callerTimestamp = performance.now() - startTime;
      const audioDurationMs = Math.round((callerAudio.length / 2 / 24000) * 1000);

      transcript.push({
        role: "caller",
        text: emittedCallerText,
        timestamp_ms: Math.round(callerTimestamp),
        caller_decision_mode: callerDecision.mode,
        audio_duration_ms: audioDurationMs,
        tts_ms: ttsMs,
      });
      recordTurnAudio(turnAudioData, callerTimestamp, {
        role: "caller",
        audioDurationMs,
        callerDecisionMode: callerDecision.mode,
      });

      // Handle noise_on_caller: mix noise into caller audio before sending
      if (audioAction?.action === "noise_on_caller") {
        callerAudio = mixCallerWithNoise(
          callerAudio,
          audioAction.noise_type ?? "babble",
          audioAction.snr_db ?? 10,
        );
      }

      sendTime = Date.now();
      console.log(
        `    [caller-send] turn=${turn} send_start t=${sinceStartMs(startTime)}ms ` +
        `audioDuration=${audioDurationMs}ms bytes=${callerAudio.length}`
      );
      await channel.sendAudio(callerAudio);
      console.log(`    [caller-send] turn=${turn} send_return t=${sinceStartMs(startTime)}ms`);

      // Handle interrupt action: wait for agent speech, then send interrupt
      if (audioAction?.action === "interrupt") {
        const { result: actionResult, agentText: actionAgentText } = await executeAudioAction(
          audioAction,
          { channel, vad: turnVAD, transcriber, callerAudioEffects: spec.caller_audio, ttsVoiceId, ttsSession },
        );
        audioActionResults.push(actionResult);
        channel.off("audio", feedSTT);

        agentText = actionAgentText;
        const agentTimestamp = performance.now() - startTime;
        recordTurnAudio(turnAudioData, agentTimestamp, {
          role: "agent",
          audioDurationMs: 0,
          speechSegments: [],
        });
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
        const agentTimestamp = performance.now() - startTime;
        recordTurnAudio(turnAudioData, agentTimestamp, {
          role: "agent",
          audioDurationMs: 0,
          speechSegments: [],
        });
        transcript.push({
          role: "agent",
          text: actionAgentText,
          timestamp_ms: Math.round(agentTimestamp),
        });
        continue;
      }

      // ── Persona-driven interruption (LLM-decided) ──────────────────
      // When interruption_style is set, we collect agent speech, then after
      // a delay ask the CallerLLM: "interrupt or listen?" The LLM decides
      // based on persona traits and conversation context.
      // low: ~3/10 turns checked, high: every turn checked
      const interruptionStyle = spec.persona?.interruption_style;
      const interruptGateProb = interruptionStyle === "high" ? 1.0 : 0.5;
      const interruptEligible = !shouldStopAfterAgentReply
        && interruptionStyle
        && turn >= 2
        && Math.random() < interruptGateProb;

      if (interruptEligible) {
        // Collect with an abort signal — we'll abort after speech onset + delay
        // to ask the LLM for an interrupt decision
        const abortCtrl = new AbortController();
        const peekMs = interruptionStyle === "high"
          ? 500 + Math.random() * 1000    // 0.5–1.5s of speech before asking
          : 1500 + Math.random() * 1500;  // 1.5–3s of speech before asking

        // Set up speech onset detection to trigger the abort after delay
        let speechDetected = false;
        const onSpeechCheck = (chunk: Buffer) => {
          if (speechDetected) return;
          // Simple energy check — speech detected when RMS > 300
          const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
          let sumSq = 0;
          for (let i = 0; i < int16.length; i++) sumSq += int16[i]! * int16[i]!;
          const rms = Math.sqrt(sumSq / int16.length);
          if (rms > 300) {
            speechDetected = true;
            setTimeout(() => abortCtrl.abort(), peekMs);
          }
        };
        channel.on("audio", onSpeechCheck);

        turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;
        const peekResult = await collectUntilEndOfTurn(
          channel,
          { timeoutMs: resolveCollectionTimeoutMs(30000), vad: turnVAD, signal: abortCtrl.signal, preferPlatformEOT: !!channel.hasPlatformEndOfTurn }
        );
        channel.off("audio", onSpeechCheck);

        if (!peekResult.aborted) {
          // Agent finished speaking before we could even ask — no interrupt opportunity.
          // Process as a normal turn (fall through to normal handling below).
          channel.off("audio", feedSTT);

          const { text: fullText, confidence } = await transcriber.finalize();
          let resolvedText = fullText;
          if (!resolvedText && channel.consumeAgentText) {
            const platformText = channel.consumeAgentText();
            if (platformText) resolvedText = platformText;
          } else {
            channel.consumeAgentText?.();
          }

          agentText = resolvedText || "";
          adaptiveThreshold.update(peekResult.stats);

          const agentTimestamp = performance.now() - startTime;
          const audioDurationMs = Math.round((peekResult.audio.length / 2 / 24000) * 1000);
          const ttfbMs = peekResult.stats.firstChunkAt ? Math.max(0, peekResult.stats.firstChunkAt - sendTime) : undefined;
          const ttfwMs = peekResult.stats.speechOnsetAt ? Math.max(0, peekResult.stats.speechOnsetAt - sendTime) : undefined;
          const speechSegments = batchVAD.analyze(peekResult.audio);
          if (spec.prosody) agentAudioBuffers.push(Buffer.from(peekResult.audio));
          turnSignalQualities.push(analyzeAudioQuality(peekResult.audio, speechSegments));
          recordTurnAudio(
            turnAudioData,
            resolveAgentAudioStartTimestampMs(agentTimestamp, audioDurationMs, callerTimestamp, ttfbMs),
            {
              role: "agent",
              audioDurationMs,
              speechSegments,
            },
          );
          transcript.push({
            role: "agent",
            text: agentText,
            timestamp_ms: Math.round(agentTimestamp),
            audio_duration_ms: audioDurationMs,
            ttfb_ms: ttfbMs,
            ttfw_ms: ttfwMs,
          });
          if (shouldStopAfterAgentReply) break;
          continue;
        }

        // We have partial agent speech — transcribe it and ask the LLM
        const partialText = await transcriber.finalize();
        const partialAgentText = partialText.text || "";
        console.log(`    [interrupt-check] turn=${turn} asking LLM: "${partialAgentText.slice(0, 60)}..."`);

        // Ask CallerLLM: interrupt or listen?
        const interruptDecision = await caller.decideInterrupt(partialAgentText, transcript);

        if (interruptDecision.mode === "listen") {
          // LLM decided to listen — continue collecting the rest of the agent response
          console.log(`    [interrupt-check] turn=${turn} LLM decided: LISTEN`);
          transcriber.resetForNextTurn();
          const feedContinueSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
          channel.on("audio", feedContinueSTT);

          const { audio: restAudio, stats: restStats } = await collectUntilEndOfTurn(
            channel,
            { timeoutMs: resolveCollectionTimeoutMs(30000), vad: turnVAD, preferPlatformEOT: !!channel.hasPlatformEndOfTurn }
          );
          channel.off("audio", feedContinueSTT);

          // Combine partial + rest transcripts
          let restText = "";
          if (restAudio.length > 0) {
            const { text } = await transcriber.finalize();
            if (!text && channel.consumeAgentText) {
              const platformText = channel.consumeAgentText();
              if (platformText) restText = platformText;
            } else {
              restText = text;
              channel.consumeAgentText?.();
            }
          }

          agentText = (partialAgentText + " " + restText).trim();
          adaptiveThreshold.update(restStats);

          const agentTimestamp = performance.now() - startTime;
          const combinedAudio = Buffer.concat([peekResult.audio, restAudio]);
          const audioDurationMs = Math.round((combinedAudio.length / 2 / 24000) * 1000);
          const ttfbMs = peekResult.stats.firstChunkAt ? Math.max(0, peekResult.stats.firstChunkAt - sendTime) : undefined;
          const ttfwMs = peekResult.stats.speechOnsetAt ? Math.max(0, peekResult.stats.speechOnsetAt - sendTime) : undefined;
          const speechSegments = batchVAD.analyze(combinedAudio);
          if (spec.prosody) agentAudioBuffers.push(Buffer.from(combinedAudio));
          turnSignalQualities.push(analyzeAudioQuality(combinedAudio, speechSegments));
          recordTurnAudio(
            turnAudioData,
            resolveAgentAudioStartTimestampMs(agentTimestamp, audioDurationMs, callerTimestamp, ttfbMs),
            {
              role: "agent",
              audioDurationMs,
              speechSegments,
            },
          );
          transcript.push({
            role: "agent",
            text: agentText,
            timestamp_ms: Math.round(agentTimestamp),
            audio_duration_ms: audioDurationMs,
            ttfb_ms: ttfbMs,
            ttfw_ms: ttfwMs,
          });
          if (shouldStopAfterAgentReply) break;
          continue;
        }

        // LLM decided to interrupt!
        const interruptText = interruptDecision.text;
        console.log(`    [interrupt] turn=${turn} LLM decided: INTERRUPT with "${interruptText.slice(0, 60)}"`);
        channel.off("audio", feedSTT);

        // Record partial agent turn (interrupted)
        const agentTimestamp = performance.now() - startTime;
        const preAudioDurationMs = Math.round((peekResult.audio.length / 2 / 24000) * 1000);
        const preTtfbMs = peekResult.stats.firstChunkAt ? Math.max(0, peekResult.stats.firstChunkAt - sendTime) : undefined;
        const preTtfwMs = peekResult.stats.speechOnsetAt ? Math.max(0, peekResult.stats.speechOnsetAt - sendTime) : undefined;
        const preSpeechSegments = batchVAD.analyze(peekResult.audio);
        if (spec.prosody) agentAudioBuffers.push(Buffer.from(peekResult.audio));
        turnSignalQualities.push(analyzeAudioQuality(peekResult.audio, preSpeechSegments));
        recordTurnAudio(
          turnAudioData,
          resolveAgentAudioStartTimestampMs(agentTimestamp, preAudioDurationMs, callerTimestamp, preTtfbMs),
          {
            role: "agent",
            audioDurationMs: preAudioDurationMs,
            speechSegments: preSpeechSegments,
            interrupted: true,
          },
        );
        transcript.push({
          role: "agent",
          text: partialAgentText,
          timestamp_ms: Math.round(agentTimestamp),
          audio_duration_ms: preAudioDurationMs,
          ttfb_ms: preTtfbMs,
          ttfw_ms: preTtfwMs,
          interrupted: true,
        });

        // TTS the interruption
        let interruptAudio = await ttsSession.synthesize(interruptText);
        if (spec.caller_audio) interruptAudio = applyEffects(interruptAudio, spec.caller_audio);

        // Send interrupt (raw = skip clear/mark for immediate delivery)
        const interruptTime = Date.now();
        sendTime = Date.now();
        await channel.sendAudio(interruptAudio, { raw: true });

        const interruptCallerTimestamp = performance.now() - startTime;
        const interruptAudioDurationMs = Math.round((interruptAudio.length / 2 / 24000) * 1000);
        recordTurnAudio(turnAudioData, interruptCallerTimestamp, {
          role: "caller",
          audioDurationMs: interruptAudioDurationMs,
          callerDecisionMode: "continue",
          isInterruption: true,
        });
        transcript.push({
          role: "caller",
          text: interruptText,
          timestamp_ms: Math.round(interruptCallerTimestamp),
          caller_decision_mode: "continue",
          audio_duration_ms: interruptAudioDurationMs,
          is_interruption: true,
        });

        // Collect post-interrupt agent response
        transcriber.resetForNextTurn();
        const feedPostSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
        channel.on("audio", feedPostSTT);

        turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;
        const { audio: postAudio, stats: postStats } = await collectUntilEndOfTurn(
          channel,
          { timeoutMs: resolveCollectionTimeoutMs(30000), vad: turnVAD, preferPlatformEOT: !!channel.hasPlatformEndOfTurn }
        );
        channel.off("audio", feedPostSTT);

        // Measure stop latency
        const stopLatencyMs = postStats.speechOnsetAt !== null
          ? Math.max(0, postStats.speechOnsetAt - interruptTime)
          : -1;
        console.log(`    [interrupt] stop_latency=${stopLatencyMs}ms`);

        let postAgentText = "";
        if (postAudio.length > 0) {
          const { text } = await transcriber.finalize();
          if (!text && channel.consumeAgentText) {
            const platformText = channel.consumeAgentText();
            if (platformText) postAgentText = platformText;
          } else {
            postAgentText = text;
            channel.consumeAgentText?.();
          }
        }

        agentText = postAgentText;
        const postAgentTimestamp = performance.now() - startTime;
        const postAudioDurationMs = Math.round((postAudio.length / 2 / 24000) * 1000);
        const postTtfbMs = postStats.firstChunkAt ? Math.max(0, postStats.firstChunkAt - interruptTime) : undefined;
        const postTtfwMs = postStats.speechOnsetAt ? Math.max(0, postStats.speechOnsetAt - interruptTime) : undefined;
        const postSpeechSegments = batchVAD.analyze(postAudio);
        if (spec.prosody) agentAudioBuffers.push(Buffer.from(postAudio));
        turnSignalQualities.push(analyzeAudioQuality(postAudio, postSpeechSegments));
        recordTurnAudio(
          turnAudioData,
          resolveAgentAudioStartTimestampMs(postAgentTimestamp, postAudioDurationMs, interruptCallerTimestamp, postTtfbMs),
          {
            role: "agent",
            audioDurationMs: postAudioDurationMs,
            speechSegments: postSpeechSegments,
          },
        );
        transcript.push({
          role: "agent",
          text: postAgentText,
          timestamp_ms: Math.round(postAgentTimestamp),
          audio_duration_ms: postAudioDurationMs,
          ttfb_ms: postTtfbMs,
          ttfw_ms: postTtfwMs,
        });

        if (shouldStopAfterAgentReply) break;
        continue;
      }

      // Step 3: Collect agent response via VAD (reused instance)
      // 30s timeout: LiveKit sendAudio is fire-and-forget with real-time pacing,
      // so frames take seconds to deliver. The agent also needs processing time
      // (STT → LLM → TTS) before responding.
      const vadStart = performance.now();
      const { audio: agentAudio, stats, timedOut } = await collectUntilEndOfTurn(
        channel,
        {
          timeoutMs: resolveCollectionTimeoutMs(30000),
          vad: turnVAD,
          preferPlatformEOT: !!channel.hasPlatformEndOfTurn,
          debugLabel: `turn-${turn}`,
        }
      );
      const vadMs = Math.round(performance.now() - vadStart);
      console.log(
        `[turn-collect] turn=${turn} bytes=${agentAudio.length} timedOut=${timedOut} ` +
        `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null} ` +
        `speechSegments=${stats.speechSegments} totalSpeechMs=${stats.totalSpeechMs}`
      );

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
        let textSource = text ? "stt" : "empty";

        // Fallback: use real-time platform transcript when STT finds nothing
        // (e.g. Bland sends agent text via control messages but binary audio is sparse)
        if (!text && channel.consumeAgentText) {
          const platformText = channel.consumeAgentText();
          if (platformText) {
            text = platformText;
            confidence = 1;
            textSource = "platform";
          }
        } else {
          // Consume and discard — keep buffer from growing across turns
          channel.consumeAgentText?.();
        }

        agentText = text;

        const totalPipelineMs = Math.round(performance.now() - turnPipelineStart);
        console.log(`[turn-timing] turn=${turn} vad_collect=${vadMs}ms stt=${sttMs}ms total_pipeline=${totalPipelineMs}ms threshold=${adaptiveThreshold.thresholdMs}ms`);
        console.log(
          `[turn-text] turn=${turn} source=${textSource} chars=${text?.length ?? 0} ` +
          `text="${summarizeDebugText(agentText)}"`
        );

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
        recordTurnAudio(
          turnAudioData,
          resolveAgentAudioStartTimestampMs(agentTimestamp, agentAudioDurationMs, callerTimestamp, turnTtfb),
          {
            role: "agent",
            audioDurationMs: agentAudioDurationMs,
            speechSegments,
          },
        );

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
        if (shouldStopAfterAgentReply) break;
      } else {
        agentText = "";
        console.log(
          `[turn-text] turn=${turn} source=empty-audio chars=0 timedOut=${timedOut} ` +
          `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null}`
        );
        recordTurnAudio(turnAudioData, agentTimestamp, {
          role: "agent",
          audioDurationMs: 0,
          speechSegments: [],
        });
        transcript.push({
          role: "agent",
          text: "",
          timestamp_ms: Math.round(agentTimestamp),
          ttfb_ms: turnTtfb,
          ttfw_ms: turnTtfw,
          silence_pad_ms: turnSilencePad,
        });
        if (shouldStopAfterAgentReply) break;
      }
    }

    // End the call cleanly so it doesn't hang until Vapi's silence timeout fires.
    await safeDisconnect();

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
      const agentTurnsForLatency = transcript
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.role === "agent");
      const responseAgentTurns = collectGreetingFirst ? agentTurnsForLatency.slice(1) : agentTurnsForLatency;

      for (let i = 0; i < rawComponentTimings.length && i < responseAgentTurns.length; i++) {
        const timing = rawComponentTimings[i];
        if (timing && (timing.stt_ms != null || timing.llm_ms != null || timing.tts_ms != null)) {
          responseAgentTurns[i]!.entry.component_latency = timing;
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

    // Step 8c: Compute metrics AFTER platform transcripts are merged (WER needs platform_transcript)
    const fullPlatformCallerText = channel.getFullCallerTranscript?.() ?? undefined;
    const { transcript: transcriptMetrics, latency, audio_analysis, harness_overhead } = await computeAllMetrics(transcript, turnAudioData, channel.stats.connectLatencyMs, fullPlatformCallerText);

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
    await safeDisconnect();
    await ttsSession.close();
    transcriber.close();
    turnVAD.destroy();
    batchVAD.destroy();
  }
}
