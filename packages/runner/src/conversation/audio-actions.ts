/**
 * Audio action handlers — infrastructure challenges injected into conversation turns.
 *
 * Each action modifies the normal conversation flow at a specific turn,
 * measuring infrastructure signals while the conversation continues.
 */

import type { AudioChannel } from "@vent/adapters";
import type { AudioAction, AudioActionResult, CallerAudioEffects } from "@vent/shared";
import {
  synthesize,
  type TTSSession,
  generateBabbleNoise,
  generateWhiteNoise,
  generatePinkNoise,
  mixAudio,
  applyEffects,
  concatPcm,
} from "@vent/voice";
import {
  collectUntilEndOfTurn,
  waitForSpeech,
  transcribeAudio,
} from "../audio-tests/helpers.js";
import type { VoiceActivityDetector, StreamingTranscriber } from "@vent/voice";

interface ActionContext {
  channel: AudioChannel;
  vad: VoiceActivityDetector;
  transcriber: StreamingTranscriber;
  callerAudioEffects?: CallerAudioEffects;
  ttsVoiceId?: string;
  ttsSession?: TTSSession;
}

/**
 * Execute an audio action at a specific turn.
 * Returns the action result and the agent's text response (if any) for CallerLLM to continue.
 */
export async function executeAudioAction(
  action: AudioAction,
  ctx: ActionContext,
): Promise<{ result: AudioActionResult; agentText: string }> {
  switch (action.action) {
    case "interrupt":
      return executeInterrupt(action, ctx);
    case "inject_noise":
      return executeInjectNoise(action, ctx);
    case "split_sentence":
      return executeSplitSentence(action, ctx);
    case "noise_on_caller":
      return executeNoiseOnCaller(action, ctx);
    default:
      throw new Error(`Unknown audio action: ${action.action}`);
  }
}

/**
 * Interrupt: send caller audio mid-agent-speech, measure stop latency.
 *
 * Flow: wait for agent to start speaking → send interrupt prompt →
 *       measure how long agent takes to stop → collect post-interrupt response.
 */
async function executeInterrupt(
  action: AudioAction,
  ctx: ActionContext,
): Promise<{ result: AudioActionResult; agentText: string }> {
  const interruptPrompt = action.prompt ?? "Actually, I have a different question.";
  const ttsOpts = ctx.ttsVoiceId ? { voiceId: ctx.ttsVoiceId } : undefined;
  let interruptAudio = ctx.ttsSession
    ? await ctx.ttsSession.synthesize(interruptPrompt)
    : await synthesize(interruptPrompt, ttsOpts);
  if (ctx.callerAudioEffects) {
    interruptAudio = applyEffects(interruptAudio, ctx.callerAudioEffects);
  }

  // We need to be mid-agent-speech, so first wait for agent to start
  // Note: the caller's normal utterance should already have been sent for this turn
  // by the executor before calling this action. This action sends the INTERRUPT.

  // Wait for agent speech to begin
  const { timedOut: noSpeech } = await waitForSpeech(ctx.channel, 10000);
  if (noSpeech) {
    return {
      result: {
        at_turn: action.at_turn,
        action: "interrupt",
        metrics: { stop_latency_ms: -1 },
        transcriptions: { pre_interruption: null, post_interruption: null },
      },
      agentText: "",
    };
  }

  // Collect ~1s of agent speech before interrupting (so there's context to switch from)
  const preInterruptAudio = await collectForDurationSafe(ctx.channel, 1000);
  const preText = await transcribeAudio(preInterruptAudio);

  // Attach feedSTT just before collection — feeding pre-collect idle audio
  // to Deepgram makes it slow to lock onto short utterances.
  await ctx.transcriber.resetForNextTurn();
  const feedSTT = (chunk: Buffer) => ctx.transcriber.feedAudio(chunk);

  // Send interrupt — clear stale audio first, then send through buffer
  const interruptTime = Date.now();
  ctx.channel.sendAudio(interruptAudio);

  ctx.channel.on("audio", feedSTT);
  const { audio: postAudio, stats } = await collectUntilEndOfTurn(ctx.channel, {
    timeoutMs: 15000,
    vad: ctx.vad,
  });
  ctx.channel.off("audio", feedSTT);

  // Measure stop latency: time from interrupt send to new speech onset
  let stopLatencyMs = -1;
  if (stats.firstChunkAt !== null) {
    stopLatencyMs = Math.max(0, stats.firstChunkAt - interruptTime);
  }

  let postText = "";
  if (postAudio.length > 0) {
    const { text } = await ctx.transcriber.finalize();
    postText = text;
  }

  return {
    result: {
      at_turn: action.at_turn,
      action: "interrupt",
      metrics: { stop_latency_ms: stopLatencyMs },
      transcriptions: { pre_interruption: preText || null, post_interruption: postText || null },
    },
    agentText: postText,
  };
}

/**
 * Inject noise: during agent speech, send noise audio into the channel.
 * Checks for false barge-in (agent falsely stops because of noise).
 */
async function executeInjectNoise(
  action: AudioAction,
  ctx: ActionContext,
): Promise<{ result: AudioActionResult; agentText: string }> {
  const noiseType = action.noise_type ?? "babble";
  const noiseDurationMs = 3000;

  // Wait for agent to start speaking
  const { timedOut: noSpeech } = await waitForSpeech(ctx.channel, 10000);
  if (noSpeech) {
    return {
      result: {
        at_turn: action.at_turn,
        action: "inject_noise",
        metrics: { false_stop: false },
      },
      agentText: "",
    };
  }

  // Generate noise
  const noiseGenerator = noiseType === "white" ? generateWhiteNoise
    : noiseType === "pink" ? generatePinkNoise
    : generateBabbleNoise;
  const noise = noiseGenerator(noiseDurationMs);

  await ctx.transcriber.resetForNextTurn();
  const feedSTT = (chunk: Buffer) => ctx.transcriber.feedAudio(chunk);

  // Send noise while agent is speaking
  ctx.channel.sendAudio(noise);

  ctx.channel.on("audio", feedSTT);
  const { audio: agentAudio, timedOut } = await collectUntilEndOfTurn(ctx.channel, {
    timeoutMs: 15000,
    vad: ctx.vad,
  });
  ctx.channel.off("audio", feedSTT);

  // If agent stopped quickly after noise and didn't resume, it falsely stopped
  const falseStop = timedOut || agentAudio.length < 2400; // < 50ms of audio

  let agentText = "";
  if (agentAudio.length > 0) {
    const { text } = await ctx.transcriber.finalize();
    agentText = text;
  }

  return {
    result: {
      at_turn: action.at_turn,
      action: "inject_noise",
      metrics: { false_stop: falseStop },
    },
    agentText,
  };
}

/**
 * Split sentence: send partA → pause → partB to check endpointing.
 * Checks if agent responds prematurely during the pause.
 */
async function executeSplitSentence(
  action: AudioAction,
  ctx: ActionContext,
): Promise<{ result: AudioActionResult; agentText: string }> {
  if (!action.split) {
    throw new Error("split_sentence action requires split config (part_a, part_b, pause_ms)");
  }

  const { part_a, part_b, pause_ms } = action.split;

  // Synthesize both parts (sequential with session, parallel with ephemeral)
  const ttsOpts = ctx.ttsVoiceId ? { voiceId: ctx.ttsVoiceId } : undefined;
  let audioA: Buffer;
  let audioB: Buffer;
  if (ctx.ttsSession) {
    audioA = await ctx.ttsSession.synthesize(part_a);
    audioB = await ctx.ttsSession.synthesize(part_b);
  } else {
    [audioA, audioB] = await Promise.all([synthesize(part_a, ttsOpts), synthesize(part_b, ttsOpts)]);
  }
  if (ctx.callerAudioEffects) {
    audioA = applyEffects(audioA, ctx.callerAudioEffects);
    audioB = applyEffects(audioB, ctx.callerAudioEffects);
  }

  // Send part A
  await ctx.channel.sendAudio(audioA);

  // During the pause, check for premature agent response
  const { timedOut: noPremature } = await waitForSpeech(ctx.channel, pause_ms);
  const prematureResponse = !noPremature;

  // If premature response, drain it
  if (prematureResponse) {
    await collectUntilEndOfTurn(ctx.channel, { timeoutMs: 10000, vad: ctx.vad });
  }

  await ctx.transcriber.resetForNextTurn();
  const feedSTT = (chunk: Buffer) => ctx.transcriber.feedAudio(chunk);

  // Send part B
  await ctx.channel.sendAudio(audioB);

  ctx.channel.on("audio", feedSTT);

  const { audio: responseAudio } = await collectUntilEndOfTurn(ctx.channel, {
    timeoutMs: 15000,
    vad: ctx.vad,
  });

  ctx.channel.off("audio", feedSTT);

  let agentText = "";
  if (responseAudio.length > 0) {
    const { text } = await ctx.transcriber.finalize();
    agentText = text;
  }

  return {
    result: {
      at_turn: action.at_turn,
      action: "split_sentence",
      metrics: { premature_response: prematureResponse },
      transcriptions: { response: agentText || null },
    },
    agentText,
  };
}

/**
 * Noise on caller: mix noise with caller TTS audio before sending.
 * Checks comprehension under degraded audio conditions.
 */
async function executeNoiseOnCaller(
  action: AudioAction,
  ctx: ActionContext,
  callerAudio?: Buffer,
): Promise<{ result: AudioActionResult; agentText: string }> {
  // This action is handled differently — the executor mixes noise into
  // the caller's already-synthesized audio before sending.
  // The actual mixing happens in the executor; this just collects the response.

  await ctx.transcriber.resetForNextTurn();
  const feedSTT = (chunk: Buffer) => ctx.transcriber.feedAudio(chunk);
  ctx.channel.on("audio", feedSTT);

  const { audio: responseAudio } = await collectUntilEndOfTurn(ctx.channel, {
    timeoutMs: 15000,
    vad: ctx.vad,
  });

  ctx.channel.off("audio", feedSTT);

  let agentText = "";
  if (responseAudio.length > 0) {
    const { text } = await ctx.transcriber.finalize();
    agentText = text;
  }

  return {
    result: {
      at_turn: action.at_turn,
      action: "noise_on_caller",
      metrics: {},
      transcriptions: { agent_response: agentText || null },
    },
    agentText,
  };
}

/**
 * Helper: collect audio for a fixed duration without VAD.
 */
export async function collectForDurationSafe(channel: AudioChannel, durationMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve) => {
    const onAudio = (chunk: Buffer) => {
      chunks.push(chunk);
    };
    const timeout = setTimeout(() => {
      channel.off("audio", onAudio);
      resolve();
    }, durationMs);
    channel.on("audio", onAudio);
  });

  return concatPcm(chunks);
}

/**
 * Prepare noise-mixed caller audio for noise_on_caller action.
 * Called by the executor before sending.
 */
export function mixCallerWithNoise(
  callerAudio: Buffer,
  noiseType: "babble" | "white" | "pink" = "babble",
  snrDb: number = 10,
): Buffer {
  const durationMs = Math.round((callerAudio.length / 2 / 24000) * 1000);
  const noiseGenerator = noiseType === "white" ? generateWhiteNoise
    : noiseType === "pink" ? generatePinkNoise
    : generateBabbleNoise;
  const noise = noiseGenerator(durationMs);
  return mixAudio(callerAudio, noise, snrDb);
}
