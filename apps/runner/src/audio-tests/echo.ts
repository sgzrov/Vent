/**
 * Echo probe (Layer 1: Infrastructure)
 *
 * Detects pipeline feedback loops where the agent's STT picks up its own
 * TTS output and responds to itself. Also checks silence recovery.
 *
 * Flow: prompt → collect response → go silent → count unprompted speech →
 *       recovery prompt → check response.
 *
 * Returns raw metrics + transcriptions — no pass/fail.
 */

import type { AudioChannel } from "@vent/adapters";
import type { AudioTestResult } from "@vent/shared";
import { synthesize } from "@vent/voice";
import { collectUntilEndOfTurn, waitForSpeech, streamSilence, transcribeAudio } from "./helpers.js";

const DEFAULT_PROMPT = "Hi, can you tell me about your services?";
const DEFAULT_SILENCE_MS = 20000;
const ECHO_WINDOW_MS = 3000;
const RECOVERY_PROMPT = "Hello, are you still there? I had a quick question.";

export async function runEchoTest(
  channel: AudioChannel,
  config?: { prompt?: string; silence_duration_ms?: number },
): Promise<AudioTestResult> {
  const prompt = config?.prompt ?? DEFAULT_PROMPT;
  const silenceDurationMs = config?.silence_duration_ms ?? DEFAULT_SILENCE_MS;
  const startTime = performance.now();

  // Phase 1: Send a real prompt and collect the agent's first response
  const promptAudio = await synthesize(prompt);
  channel.sendAudio(promptAudio);

  const { audio: initialAudio } = await collectUntilEndOfTurn(channel, { timeoutMs: 15000 });
  const initialText = await transcribeAudio(initialAudio);

  // Phase 2: Go silent — count unprompted agent responses
  const silenceStart = Date.now();
  let unpromptedCount = 0;
  const unpromptedTexts: string[] = [];

  // Stream silence to keep the connection alive
  const silencePromise = streamSilence(channel, silenceDurationMs);

  while (Date.now() - silenceStart < silenceDurationMs) {
    const remaining = silenceDurationMs - (Date.now() - silenceStart);
    if (remaining < ECHO_WINDOW_MS) break;

    const { timedOut } = await waitForSpeech(channel, Math.min(ECHO_WINDOW_MS, remaining));
    if (timedOut) break;

    unpromptedCount++;

    // Drain and transcribe the unprompted utterance
    const { audio: unpromptedAudio } = await collectUntilEndOfTurn(channel, { timeoutMs: 10000 });
    const text = await transcribeAudio(unpromptedAudio);
    if (text) unpromptedTexts.push(text);
  }

  await silencePromise;

  // Phase 3: Recovery — send a follow-up prompt to check if agent is responsive
  const recoveryAudio = await synthesize(RECOVERY_PROMPT);
  channel.sendAudio(recoveryAudio);

  const { audio: recoveryResponseAudio, timedOut: recoveryTimedOut } = await collectUntilEndOfTurn(channel, {
    timeoutMs: 15000,
  });
  const recoveryText = recoveryTimedOut ? null : await transcribeAudio(recoveryResponseAudio);
  const recoveryResponded = !recoveryTimedOut && recoveryResponseAudio.length > 0;

  return {
    test_name: "echo",
    status: "completed",
    metrics: {
      unprompted_utterances: unpromptedCount,
      silence_duration_ms: silenceDurationMs,
      recovery_responded: recoveryResponded,
    },
    transcriptions: {
      initial: initialText || null,
      unprompted_texts: unpromptedTexts.length > 0 ? unpromptedTexts : null,
      recovery: recoveryText,
    },
    duration_ms: Math.round(performance.now() - startTime),
  };
}
