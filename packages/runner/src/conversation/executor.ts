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
import { synthesize, TTSSession, BatchVAD, VoiceActivityDetector, StreamingTranscriber, applyEffects, resolveAccentVoiceId, resolveLanguageVoiceId, analyzeAudioQuality, concatPcm, type AudioQualityMetrics } from "@vent/voice";
import { CallerLLM } from "./caller-llm.js";
import { executeAudioAction, mixCallerWithNoise, collectForDurationSafe } from "./audio-actions.js";
import { collectUntilEndOfTurn, linearRegressionSlope } from "../audio-tests/helpers.js";
import { computeAllMetrics } from "../metrics/index.js";
import { analyzeProsody } from "../metrics/prosody.js";
import { AdaptiveThreshold } from "./adaptive-threshold.js";

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

// Merge adjacent same-role agent turns. The 1500ms end-of-turn VAD can split a
// single agent utterance across two executor turns (e.g. "Let me" → caller waits
// → "ask my mother..."); the resulting pair is one logical turn for the user.
// Only the first fragment's TTFB/TTFW reflect real response latency; subsequent
// fragments are a continuation, so their timing fields are dropped.
function mergeFracturedAgentTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const merged: ConversationTurn[] = [];
  for (const turn of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === "agent" && turn.role === "agent") {
      const joinedText = [prev.text, turn.text].filter((t) => t && t.length > 0).join(" ");
      prev.text = joinedText;
      if (turn.audio_duration_ms != null) {
        prev.audio_duration_ms = (prev.audio_duration_ms ?? 0) + turn.audio_duration_ms;
      }
      if (turn.stt_ms != null) {
        prev.stt_ms = (prev.stt_ms ?? 0) + turn.stt_ms;
      }
      if (turn.platform_transcript) {
        prev.platform_transcript = [prev.platform_transcript, turn.platform_transcript]
          .filter((t) => t && t.length > 0)
          .join(" ");
      }
      continue;
    }
    merged.push({ ...turn });
  }
  return merged;
}

export interface RunConversationCallOpts {
  /** Called after channel.connect() resolves, while runConversationCall owns
   *  the lifecycle. Used by the outer runner to start recording upload after
   *  the channel is ready — kept as a callback so connect() can be invoked
   *  here, not before runConversationCall, so the STT listener is attached
   *  BEFORE the transport starts emitting audio. */
  onConnected?: () => Promise<void>;
}

export async function runConversationCall(
  spec: ConversationCallSpec,
  channel: AudioChannel,
  opts: RunConversationCallOpts = {},
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

  // Attach the opening STT feed BEFORE connecting the channel's transport so
  // no audio frames can arrive with zero listeners. Greeting-start clipping
  // (the "Hi, Thanks" prefix getting dropped from the transcript) comes from
  // this exact window — any audio emitted before the listener attaches is
  // lost (we deliberately don't buffer, since bursting a buffer into Deepgram
  // collapses its endpointing). Detached again after the opening finalize
  // so subsequent turns can manage their own attach/detach without duplicate
  // listeners double-feeding Deepgram.
  const openingFeedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
  channel.on("audio", openingFeedSTT);
  await channel.connect();
  await opts.onConnected?.();

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

  const agentAudioBuffers: Buffer[] = [];
  const turnSignalQualities: AudioQualityMetrics[] = [];
  const audioActionResults: AudioActionResult[] = [];
  let agentText: string | null = null;

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
        // No resetForNextTurn or feedSTT attach here — transcriber is already
        // connected and feedSTT is already attached at call setup so the
        // opening's first audio chunks aren't lost to an unattached listener.
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
          greetingText = text;
        }
        // Release the call-level STT listener now that the opening is done.
        // Subsequent turns manage their own feedSTT attach/detach around
        // collection to avoid feeding Deepgram during caller-LLM/TTS idle
        // audio (which slows CloseStream).
        channel.off("audio", openingFeedSTT);
        channel.consumeAgentText?.();

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
      // Check for audio action at this turn (split_sentence skips CallerLLM)
      const audioAction = spec.audio_actions?.find((a) => a.at_turn === turn);

      if (audioAction && audioAction.action === "split_sentence") {
        // This action replaces the caller utterance entirely
        const callerTimestamp = performance.now() - startTime;
        const actionLabel = `[split: "${audioAction.split?.part_a}" ... "${audioAction.split?.part_b}"]`;

        transcript.push({
          role: "caller",
          text: actionLabel,
          timestamp_ms: Math.round(callerTimestamp),
        });

        turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;

        const { result: actionResult, agentText: actionAgentText } = await executeAudioAction(
          audioAction,
          { channel, vad: turnVAD, transcriber, callerAudioEffects: spec.caller_audio, ttsVoiceId, ttsSession },
        );
        audioActionResults.push(actionResult);
        agentText = actionAgentText;

        const agentTimestamp = performance.now() - startTime;
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

      // Reset STT (opens new Deepgram connection for this turn).
      // feedSTT is attached right before collection, not here — attaching
      // during LLM+TTS feeds idle audio that slows down CloseStream.
      await transcriber.resetForNextTurn();
      const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);

      let sendTime: number;

      let callerAudio: Buffer | null = null;
      let callerDecision: Awaited<ReturnType<CallerLLM["nextUtterance"]>>;
      let llmMs: number = 0;
      let spokenCallerText: string | null = null;

      // ── Streaming LLM → TTS → channel pipeline ──────────────────────
      // LLM streams tokens and yields sentences via callback into a queue.
      // A concurrent consumer synthesizes each sentence via streaming TTS
      // and pipes audio chunks to the channel as they arrive.
      // For "wait"/"end_now" modes, no sentences are yielded so no audio is sent.
      const llmStart = performance.now();
      const callerAudioChunks: Buffer[] = [];

      // ── Pipecat-style streaming pipeline ──────────────────────────
      // 1. Set up TTS audio listener FIRST (captures audio as it arrives)
      // 2. Stream LLM tokens → detect sentences → sendText per sentence
      //    (Deepgram produces audio immediately per Speak message, no flush needed)
      // 3. Flush once at the end to process any remaining buffer
      const ttsStart = performance.now();

      // Start TTS stream — audio listener queues chunks for sequential sending
      const audioSendQueue: Buffer[] = [];
      const audioNotify = { fn: null as (() => void) | null };
      let ttsFinished = false;

      const ttsStream = ttsSession.startStreaming((chunk) => {
        callerAudioChunks.push(chunk);
        audioSendQueue.push(chunk);
        audioNotify.fn?.();
        audioNotify.fn = null;
      });

      // Concurrent audio sender — sends chunks sequentially as they arrive
      const audioSendPromise = (async () => {
        while (true) {
          if (audioSendQueue.length > 0) {
            const chunk = audioSendQueue.shift()!;
            let audio = chunk;
            if (spec.caller_audio) audio = applyEffects(audio, spec.caller_audio);
            await channel.sendAudio(audio);
          } else if (ttsFinished) {
            break;
          } else {
            await new Promise<void>((r) => { audioNotify.fn = r; });
          }
        }
      })();

      // Stream LLM — each sentence is sent to Deepgram TTS as it's detected
      callerDecision = await caller.streamNextUtterance(
        agentText,
        transcript,
        (sentence) => {
          const spoken = prepareCallerSpeechText(channel, sentence);
          ttsStream.sendText((spoken ?? sentence) + " ");
        },
      );

      // Flush remaining TTS buffer and wait for all audio to arrive
      await ttsStream.finish();
      ttsFinished = true;
      audioNotify.fn?.();
      await audioSendPromise;

      // Flush the adapter's audio buffer (drain remaining frames + silence tail)
      await channel.flushAudioBuffer?.();
      ttsMs = Math.round(performance.now() - ttsStart);

      if (callerAudioChunks.length > 0) {
        callerAudio = concatPcm(callerAudioChunks);
      }

      const shouldStopAfterAgentReply = callerDecision?.mode === "closing";

      if (!callerDecision || callerDecision.mode === "end_now") {
        break;
      }

      if (callerDecision.mode === "wait") {
        console.log(`[turn-decision] turn=${turn} caller=wait caller_llm=${llmMs}ms`);

        channel.on("audio", feedSTT);
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

        if (timedOut && stats.speechOnsetAt === null) {
          // After a closing turn, silence means the agent hung up — that's normal
          if (shouldStopAfterAgentReply) {
            channel.off("audio", feedSTT);
            console.log(`    [closing] Agent silent after caller goodbye — ending call normally`);
            break;
          }
          channel.off("audio", feedSTT);
          const diag = channel.getReceiveDiagnostics?.();
          if (diag) console.log(diag);
          throw new Error(
            `Agent stopped responding — no speech detected for 30s after turn ${turn + 1}. ` +
            `This may indicate the agent's backend (STT/LLM/TTS) is overwhelmed or rate-limited.`
          );
        }

        adaptiveThreshold.update(stats);

        const agentTimestamp = performance.now() - startTime;

        if (agentAudio.length > 0) {
          channel.off("audio", feedSTT);
          channel.startComfortNoise?.();
          const sttStart = performance.now();
          let { text, confidence } = await transcriber.finalize();
          const sttMs = Math.round(performance.now() - sttStart);
          const textSource = text ? "stt" : "empty";
          // Drain platform transcript buffer so it doesn't accumulate across
          // turns. Vent's own STT is authoritative — we listen like a real
          // caller would hear the call.
          channel.consumeAgentText?.();

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
          channel.off("audio", feedSTT);
          agentText = "";
          console.log(
            `[turn-text] turn=${turn} caller=wait source=empty-audio chars=0 timedOut=${timedOut} ` +
            `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null}`
          );
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

      // Audio was already sent to the channel during the streaming pipeline above.
      // Set up remaining state for this turn.
      callerText = callerDecision.text;
      spokenCallerText = prepareCallerSpeechText(channel, callerText);
      const emittedCallerText = spokenCallerText ?? callerText;
      const interruptionStyle = spec.persona?.interruption_style;

      console.log(
        `    [caller] turn=${turn} decision=${callerDecision.mode} t=${sinceStartMs(startTime)}ms ` +
        `text="${summarizeDebugText(emittedCallerText)}"`
      );

      // Interrupt planning still uses the old blocking TTS path
      const interruptGateProb = interruptionStyle === "high" ? 1.0 : 0.5;
      const interruptPlanEligible = !shouldStopAfterAgentReply
        && interruptionStyle
        && turn >= 2
        && Math.random() < interruptGateProb;
      const interruptPlanPromise = interruptPlanEligible
        ? caller.planInterrupt(emittedCallerText)
        : Promise.resolve({ mode: "listen" } as const);
      const interruptPlan = await interruptPlanPromise;
      const plannedInterrupt = interruptPlan.mode === "interrupt"
        ? {
            text: interruptPlan.text,
            delayMs: interruptionStyle === "high"
              ? 500 + Math.random() * 1000
              : 1500 + Math.random() * 1500,
            audioPromise: (async () => {
              let audio = await ttsSession.synthesize(interruptPlan.text);
              if (spec.caller_audio) audio = applyEffects(audio, spec.caller_audio);
              return audio;
            })(),
          }
        : null;

      if (!callerAudio) {
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

      // Audio was already sent to the channel during the streaming pipeline.
      // For noise_on_caller actions, we need to re-send with noise mixed in.
      if (audioAction?.action === "noise_on_caller") {
        callerAudio = mixCallerWithNoise(
          callerAudio,
          audioAction.noise_type ?? "babble",
          audioAction.snr_db ?? 10,
        );
        await channel.sendAudio(callerAudio);
      }

      sendTime = Date.now();
      console.log(
        `    [caller-send] turn=${turn} t=${sinceStartMs(startTime)}ms ` +
        `audioDuration=${audioDurationMs}ms bytes=${callerAudio.length}`
      );

      // Attach STT feed — agent response audio starts arriving after caller sends.
      channel.on("audio", feedSTT);

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
        transcript.push({
          role: "agent",
          text: actionAgentText,
          timestamp_ms: Math.round(agentTimestamp),
        });
        continue;
      }

      // ── Preplanned persona interruption ─────────────────────────────
      // If the caller persona is likely to cut the agent off, plan that
      // before the turn starts and execute it inline once speech begins.
      if (plannedInterrupt) {
        const abortCtrl = new AbortController();

        let speechDetected = false;
        const onSpeechCheck = (chunk: Buffer) => {
          if (speechDetected) return;
          const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
          let sumSq = 0;
          for (let i = 0; i < int16.length; i++) sumSq += int16[i]! * int16[i]!;
          const rms = Math.sqrt(sumSq / int16.length);
          if (rms > 300) {
            speechDetected = true;
            setTimeout(() => abortCtrl.abort(), plannedInterrupt.delayMs);
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
          // Agent finished speaking before the preplanned cut-in point.
          channel.off("audio", feedSTT);

          const { text: fullText, confidence } = await transcriber.finalize();
          let resolvedText = fullText;
          channel.consumeAgentText?.();

          agentText = resolvedText || "";
          adaptiveThreshold.update(peekResult.stats);

          const agentTimestamp = performance.now() - startTime;
          const audioDurationMs = Math.round((peekResult.audio.length / 2 / 24000) * 1000);
          const ttfbMs = peekResult.stats.firstChunkAt !== null ? Math.max(0, peekResult.stats.firstChunkAt - sendTime) : undefined;
          const ttfwMs = peekResult.stats.speechOnsetAt !== null ? Math.max(0, peekResult.stats.speechOnsetAt - sendTime) : undefined;
          const speechSegments = batchVAD.analyze(peekResult.audio);
          if (spec.prosody) agentAudioBuffers.push(Buffer.from(peekResult.audio));
          turnSignalQualities.push(analyzeAudioQuality(peekResult.audio, speechSegments));
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

        // We have partial agent speech — send the preplanned interruption.
        channel.off("audio", feedSTT);
        const partialText = await transcriber.finalize();
        const partialAgentText = partialText.text || "";
        console.log(`    [interrupt-plan] turn=${turn} sending planned interruption="${plannedInterrupt.text.slice(0, 60)}"`);

        // Record partial agent turn (was interrupted mid-speech)
        const agentTimestamp = performance.now() - startTime;
        const preAudioDurationMs = Math.round((peekResult.audio.length / 2 / 24000) * 1000);
        const preTtfbMs = peekResult.stats.firstChunkAt !== null ? Math.max(0, peekResult.stats.firstChunkAt - sendTime) : undefined;
        const preTtfwMs = peekResult.stats.speechOnsetAt !== null ? Math.max(0, peekResult.stats.speechOnsetAt - sendTime) : undefined;
        const preSpeechSegments = batchVAD.analyze(peekResult.audio);
        if (spec.prosody) agentAudioBuffers.push(Buffer.from(peekResult.audio));
        turnSignalQualities.push(analyzeAudioQuality(peekResult.audio, preSpeechSegments));
        transcript.push({
          role: "agent",
          text: partialAgentText,
          timestamp_ms: Math.round(agentTimestamp),
          audio_duration_ms: preAudioDurationMs,
          ttfb_ms: preTtfbMs,
          ttfw_ms: preTtfwMs,
        });

        // Send interrupt (raw = skip clear/mark for immediate delivery)
        const interruptAudio = await plannedInterrupt.audioPromise;
        const interruptTime = Date.now();
        sendTime = Date.now();
        channel.sendAudio(interruptAudio);

        const interruptCallerTimestamp = performance.now() - startTime;
        const interruptAudioDurationMs = Math.round((interruptAudio.length / 2 / 24000) * 1000);
        transcript.push({
          role: "caller",
          text: plannedInterrupt.text,
          timestamp_ms: Math.round(interruptCallerTimestamp),
          caller_decision_mode: "continue",
          audio_duration_ms: interruptAudioDurationMs,
        });

        // Collect post-interrupt agent response
        await transcriber.resetForNextTurn();
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
          postAgentText = text;
          channel.consumeAgentText?.();
        }

        agentText = postAgentText;
        const postAgentTimestamp = performance.now() - startTime;
        const postAudioDurationMs = Math.round((postAudio.length / 2 / 24000) * 1000);
        const postTtfbMs = postStats.firstChunkAt !== null ? Math.max(0, postStats.firstChunkAt - interruptTime) : undefined;
        const postTtfwMs = postStats.speechOnsetAt !== null ? Math.max(0, postStats.speechOnsetAt - interruptTime) : undefined;
        const postSpeechSegments = batchVAD.analyze(postAudio);
        if (spec.prosody) agentAudioBuffers.push(Buffer.from(postAudio));
        turnSignalQualities.push(analyzeAudioQuality(postAudio, postSpeechSegments));
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
      let { audio: agentAudio, stats, timedOut } = await collectUntilEndOfTurn(
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



      // Fail fast: if no speech detected within timeout, agent has stopped responding
      if (timedOut && stats.speechOnsetAt === null) {
        channel.off("audio", feedSTT);
        const diag = channel.getReceiveDiagnostics?.();
        if (diag) console.log(diag);
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

      let agentTimestamp = performance.now() - startTime;

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
        channel.off("audio", feedSTT);
        // Keep the codec warm during LLM+TTS processing to prevent
        // the agent from detecting silence and saying "are you still there?"
        channel.startComfortNoise?.();
        const sttStart = performance.now();
        let { text, confidence } = await transcriber.finalize();
        let sttMs = Math.round(performance.now() - sttStart);
        const textSource = text ? "stt" : "empty";
        // Drain platform buffer — Vent's own STT is authoritative (we listen
        // like a real caller).
        channel.consumeAgentText?.();

        agentText = text;

        // ── Filler speech detection (platform EOT adapters only) ──────────
        // When the agent says filler ("Let me check that") before a tool call,
        // Retell fires agent_stop_talking and we resolve the turn. But the real
        // answer hasn't arrived yet. Detect filler via a fast Haiku call, then
        // collect the continuation segment and merge into one logical turn.
        const agentWordCount = agentText ? agentText.trim().split(/\s+/).length : 0;
        if (channel.hasPlatformEndOfTurn && agentText && agentWordCount > 0 && agentWordCount <= 12) {
          const fillerClassification = await caller.classifyAgentSpeech(agentText);

          if (fillerClassification === "filler") {
            console.log(
              `[filler-continuation] turn=${turn} detected filler="${summarizeDebugText(agentText)}" — collecting continuation`
            );

            const fillerAudio = agentAudio;

            await transcriber.resetForNextTurn();
            const feedContinuationSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
            channel.on("audio", feedContinuationSTT);

            turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;
            const continuation = await collectUntilEndOfTurn(channel, {
              timeoutMs: resolveCollectionTimeoutMs(30000),
              vad: turnVAD,
              preferPlatformEOT: true,
              debugLabel: `turn-${turn}-continuation`,
            });
            channel.off("audio", feedContinuationSTT);

            if (continuation.audio.length > 0 && continuation.stats.speechOnsetAt !== null) {
              const contSttStart = performance.now();
              const contResult = await transcriber.finalize();
              const contSttMs = Math.round(performance.now() - contSttStart);
              channel.consumeAgentText?.();

              agentAudio = concatPcm([fillerAudio, continuation.audio]);
              agentText = agentText + " " + (contResult.text || "");
              sttMs += contSttMs;
              confidence = contResult.confidence;

              adaptiveThreshold.update(continuation.stats);
              agentTimestamp = performance.now() - startTime;

              console.log(
                `[filler-continuation] turn=${turn} merged text="${summarizeDebugText(agentText)}" ` +
                `continuation_bytes=${continuation.audio.length}`
              );
            } else {
              console.log(
                `[filler-continuation] turn=${turn} no continuation speech — using filler as-is`
              );
            }
          }
        }

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
        channel.off("audio", feedSTT);
        agentText = "";
        console.log(
          `[turn-text] turn=${turn} source=empty-audio chars=0 timedOut=${timedOut} ` +
          `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null}`
        );
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

    // Collapse transcript fragments created by VAD end-of-turn splitting so
    // downstream turn-index matching and latency stats see one logical turn.
    const mergedTranscript = mergeFracturedAgentTurns(transcript);
    transcript.length = 0;
    transcript.push(...mergedTranscript);

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
        const index = 0.95 * (sorted.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const value = lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
        return Math.round(value);
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

    // Step 8c: Compute metrics
    const { latency, harness_overhead } = await computeAllMetrics(
      transcript,
      channel.stats.connectLatencyMs,
    );

    // Step 9: Collect platform call metadata (cost, ended reason, recording, analysis)
    const callMetadata = await channel.getCallMetadata?.() ?? null;
    if (callMetadata) {
      console.log(`    Call metadata: ended_reason=${callMetadata.ended_reason ?? "unknown"}, cost=$${callMetadata.cost_usd?.toFixed(4) ?? "n/a"}`);
    }

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
      latency,
      signal_quality: signalQuality,
      tool_calls: toolCallMetrics,
      prosody: prosodyResult?.metrics,
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
