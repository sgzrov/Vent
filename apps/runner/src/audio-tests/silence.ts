/**
 * Silence handling test — verifies agent behavior during extended silence.
 *
 * Procedure:
 * 1. Send a greeting via TTS
 * 2. Wait for agent to respond
 * 3. Go completely silent for an extended period
 * 4. Check if agent re-prompts (good) or does nothing/disconnects (bad)
 */

import type { AudioChannel } from "@voiceci/adapters";
import type { AudioTestResult, AudioTestThresholds } from "@voiceci/shared";
import { synthesize } from "@voiceci/voice";
import { waitForSpeech, collectUntilEndOfTurn } from "./helpers.js";

const DEFAULT_SILENCE_DURATION_MS = 8000;
const RE_PROMPT_TIMEOUT_MS = 15000;

export async function runSilenceHandlingTest(
  channel: AudioChannel,
  thresholds?: AudioTestThresholds,
): Promise<AudioTestResult> {
  const SILENCE_DURATION_MS = thresholds?.silence_handling?.silence_duration_ms ?? DEFAULT_SILENCE_DURATION_MS;
  const startTime = performance.now();

  // Step 1: Send greeting to start conversation
  const greeting = await synthesize("Hi there!");
  channel.sendAudio(greeting);

  // Wait for and drain agent's initial response
  const { timedOut: noResponse } = await waitForSpeech(channel, 10000);
  if (noResponse) {
    return {
      test_name: "silence_handling",
      status: "fail",
      metrics: { agent_responded: false, agent_reprompted: false },
      duration_ms: Math.round(performance.now() - startTime),
      error: "Agent did not respond to initial greeting",
    };
  }

  await collectUntilEndOfTurn(channel, { timeoutMs: 10000 });

  // Step 2: Go silent — stream silence in 20ms chunks for realistic behavior
  const CHUNK_MS = 20;
  const chunkSize = Math.floor(24000 * 2 * (CHUNK_MS / 1000)); // 960 bytes per 20ms
  const totalChunks = Math.ceil(SILENCE_DURATION_MS / CHUNK_MS);
  const silenceChunk = Buffer.alloc(chunkSize);
  for (let i = 0; i < totalChunks; i++) {
    channel.sendAudio(silenceChunk);
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }

  // Step 3: Wait to see if agent re-prompts
  const { timedOut: noReprompt } = await waitForSpeech(
    channel,
    RE_PROMPT_TIMEOUT_MS
  );

  // Check if channel is still connected
  const stillConnected = channel.connected;
  const agentReprompted = !noReprompt;

  const durationMs = Math.round(performance.now() - startTime);

  // Agent should stay connected and ideally re-prompt
  const passed = stillConnected;

  return {
    test_name: "silence_handling",
    status: passed ? "pass" : "fail",
    metrics: {
      agent_responded: true,
      still_connected: stillConnected,
      agent_reprompted: agentReprompted,
      silence_duration_ms: SILENCE_DURATION_MS,
    },
    duration_ms: durationMs,
    ...(!passed && {
      error: "Agent disconnected during silence period",
    }),
  };
}
