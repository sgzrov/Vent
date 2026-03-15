/**
 * Infrastructure probe dispatcher — maps Layer 1 test names to executor functions.
 * Adds diagnostics (error origin classification + timing) to every result.
 */

import type { AudioChannel } from "@vent/adapters";
import type { AudioTestName, AudioTestResult, TestDiagnostics } from "@vent/shared";

/** @deprecated Infrastructure probes are now integrated into conversation tests. */
interface InfrastructureProbeConfig {
  prompt?: string;
  [key: string]: unknown;
}
import { runAudioQualityTest } from "./audio-quality.js";
import { runLatencyTest } from "./latency.js";
import { runEchoTest } from "./echo.js";

type ProbeExecutor = (channel: AudioChannel, config?: Record<string, unknown>) => Promise<AudioTestResult>;

const EXECUTORS: Record<AudioTestName, ProbeExecutor> = {
  audio_quality: runAudioQualityTest as ProbeExecutor,
  latency: runLatencyTest as ProbeExecutor,
  echo: runEchoTest as ProbeExecutor,
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
  if (result.status === "completed") return null;
  if (!result.error) return "agent";

  for (const pattern of PLATFORM_ERROR_PATTERNS) {
    if (pattern.test(result.error)) return "platform";
  }

  if (channel.stats.errorEvents.length > 0) return "platform";
  return "agent";
}

/**
 * Run a single infrastructure probe by name against a connected AudioChannel.
 */
export async function runInfrastructureProbe(
  testName: AudioTestName,
  channel: AudioChannel,
  config?: InfrastructureProbeConfig,
): Promise<AudioTestResult> {
  const executor = EXECUTORS[testName];
  const testStart = Date.now();

  // Merge global prompt with per-probe config
  const perProbeConfig = config?.[testName] as Record<string, unknown> | undefined;
  const probeConfig: Record<string, unknown> = {
    prompt: config?.prompt,
    ...perProbeConfig,
  };

  try {
    const result = await executor(channel, probeConfig);

    result.diagnostics = {
      error_origin: classifyErrorOrigin(result, channel),
      error_detail: result.error ?? null,
      timing: {
        channel_connect_ms: channel.stats.connectLatencyMs,
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
      status: "error",
      metrics: {},
      transcriptions: {},
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
