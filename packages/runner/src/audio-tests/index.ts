/**
 * Infrastructure probe dispatcher — maps Layer 1 call names to executor functions.
 * Adds diagnostics (error origin classification + timing) to every result.
 */

import type { AudioChannel } from "@vent/adapters";
import type { AudioCallName, AudioCallResult, CallDiagnostics } from "@vent/shared";

/** @deprecated Infrastructure probes are now integrated into conversation calls. */
interface InfrastructureProbeConfig {
  prompt?: string;
  [key: string]: unknown;
}
import { runAudioQualityCall } from "./audio-quality.js";
import { runLatencyCall } from "./latency.js";
import { runEchoCall } from "./echo.js";

type ProbeExecutor = (channel: AudioChannel, config?: Record<string, unknown>) => Promise<AudioCallResult>;

const EXECUTORS: Record<AudioCallName, ProbeExecutor> = {
  audio_quality: runAudioQualityCall as ProbeExecutor,
  latency: runLatencyCall as ProbeExecutor,
  echo: runEchoCall as ProbeExecutor,
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

function classifyErrorOrigin(result: AudioCallResult, channel: AudioChannel): CallDiagnostics["error_origin"] {
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
  callName: AudioCallName,
  channel: AudioChannel,
  config?: InfrastructureProbeConfig,
): Promise<AudioCallResult> {
  const executor = EXECUTORS[callName];
  const callStart = Date.now();

  // Merge global prompt with per-probe config
  const perProbeConfig = config?.[callName] as Record<string, unknown> | undefined;
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
      call_name: callName,
      status: "error",
      metrics: {},
      transcriptions: {},
      duration_ms: Date.now() - callStart,
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
