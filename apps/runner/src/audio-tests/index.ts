/**
 * Audio test dispatcher — maps test names to executor functions.
 * Adds diagnostics (error origin classification + timing) to every result.
 */

import type { AudioChannel } from "@voiceci/adapters";
import type { AudioTestName, AudioTestResult, AudioTestThresholds, TestDiagnostics } from "@voiceci/shared";
import { runEchoTest } from "./echo.js";
import { runBargeInTest } from "./barge-in.js";
import { runTtfbTest } from "./ttfb.js";
import { runSilenceHandlingTest } from "./silence.js";
import { runConnectionStabilityTest } from "./connection.js";
import { runCompletenessTest } from "./completeness.js";
import { runNoiseResilienceTest } from "./noise-resilience.js";
import { runEndpointingTest } from "./endpointing.js";
import { runAudioQualityTest } from "./audio-quality.js";

type AudioTestExecutor = (channel: AudioChannel, thresholds?: AudioTestThresholds) => Promise<AudioTestResult>;

const EXECUTORS: Record<AudioTestName, AudioTestExecutor> = {
  echo: runEchoTest,
  barge_in: runBargeInTest,
  ttfb: runTtfbTest,
  silence_handling: runSilenceHandlingTest,
  connection_stability: runConnectionStabilityTest,
  response_completeness: runCompletenessTest,
  noise_resilience: runNoiseResilienceTest,
  endpointing: runEndpointingTest,
  audio_quality: runAudioQualityTest,
};

/** Platform-side errors: TTS/STT provider failures, connection issues */
const PLATFORM_ERROR_PATTERNS = [
  /Deepgram TTS/i,
  /Deepgram.*failed/i,
  /Missing.*API key/i,
  /WebSocket.*connect/i,
  /WebSocket not connected/i,
  /connection failed/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /fetch failed/i,
];

function classifyErrorOrigin(result: AudioTestResult, channel: AudioChannel): TestDiagnostics["error_origin"] {
  if (result.status === "pass") return null;
  if (!result.error) return "agent";

  // Check if the error matches known platform failure patterns
  for (const pattern of PLATFORM_ERROR_PATTERNS) {
    if (pattern.test(result.error)) return "platform";
  }

  // Channel-level errors indicate platform issues
  if (channel.stats.errorEvents.length > 0) return "platform";

  // Connection lost = could be either, but lean toward agent issue
  // (agent dropped the connection, not our infrastructure)
  return "agent";
}

/**
 * Run a single audio test by name against a connected AudioChannel.
 * Wraps the result with diagnostics for error classification.
 */
export async function runAudioTest(
  testName: AudioTestName,
  channel: AudioChannel,
  thresholds?: AudioTestThresholds,
): Promise<AudioTestResult> {
  const executor = EXECUTORS[testName];
  const testStart = Date.now();

  try {
    const result = await executor(channel, thresholds);

    result.diagnostics = {
      error_origin: classifyErrorOrigin(result, channel),
      error_detail: result.error ?? null,
      timing: {
        channel_connect_ms: channel.stats.connectLatencyMs,
        agent_response_wait_ms: result.duration_ms,
      },
      channel: {
        connected: channel.connected,
        error_events: channel.stats.errorEvents,
        audio_bytes_sent: channel.stats.bytesSent,
        audio_bytes_received: channel.stats.bytesReceived,
      },
    };

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      test_name: testName,
      status: "fail",
      metrics: {},
      duration_ms: Date.now() - testStart,
      error: errorMsg,
      diagnostics: {
        error_origin: "platform",
        error_detail: errorMsg,
        timing: {
          channel_connect_ms: channel.stats.connectLatencyMs,
        },
        channel: {
          connected: channel.connected,
          error_events: channel.stats.errorEvents,
          audio_bytes_sent: channel.stats.bytesSent,
          audio_bytes_received: channel.stats.bytesReceived,
        },
      },
    };
  }
}
