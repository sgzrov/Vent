/**
 * Call execution logic — conversation and red team calls run in parallel with a concurrency limiter.
 * Audio quality analysis, latency drift, and echo detection are integrated
 * into each call (no standalone infrastructure probes).
 */

import { randomUUID } from "node:crypto";
import type {
  CallSpec,
  ConversationCallResult,
  RunAggregateV2,
} from "@vent/shared";
import { buildArtifactUrl, createArtifactToken, createStorageClient } from "@vent/artifacts";
import { createAudioChannel, type AudioChannelConfig } from "@vent/adapters";
import { runConversationCall } from "./conversation/index.js";

export interface CallStartInfo {
  call_name: string;
}

export interface ExecuteCallsOpts {
  callSpec: CallSpec;
  channelConfig: AudioChannelConfig;
  runId?: string;
  concurrencyLimit?: number;
  onCallStart?: (info: CallStartInfo) => void;
  onCallComplete?: (result: ConversationCallResult) => void | Promise<void>;
}

export interface ExecuteCallsResult {
  status: "pass" | "fail";
  conversationResults: ConversationCallResult[];
  aggregate: RunAggregateV2;
}

/**
 * Circuit breaker state — shared across all concurrent workers.
 * Aborts the run after consecutive connection failures to avoid
 * N identical timeouts when the agent is unreachable.
 */
interface ConcurrencyState {
  aborted: boolean;
  abortReason: string | null;
  consecutiveConnectionFailures: number;
}

interface ActiveRecordingUpload {
  finalize(): Promise<string | null>;
  abort(): Promise<void>;
}

let storageClient:
  | ReturnType<typeof createStorageClient>
  | null
  | undefined;

function getStorageClient() {
  if (storageClient !== undefined) return storageClient;
  try {
    storageClient = createStorageClient();
  } catch {
    storageClient = null;
  }
  return storageClient;
}

function slugifyRecordingLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "call";
}

async function attachRecordingUrl(
  result: ConversationCallResult,
  channel: ReturnType<typeof createAudioChannel>,
  channelConfig: AudioChannelConfig,
  activeUpload: ActiveRecordingUpload | null,
  runId?: string,
): Promise<void> {
  if (result.call_metadata?.recording_url) {
    await activeUpload?.abort().catch(() => {});
    await channel.discardCallRecording?.().catch(() => {});
    return;
  }
  if (!runId) {
    await activeUpload?.abort().catch(() => {});
    await channel.discardCallRecording?.().catch(() => {});
    return;
  }

  if (activeUpload) {
    try {
      const recordingUrl = await activeUpload.finalize();
      if (recordingUrl) {
        result.call_metadata = {
          platform: result.call_metadata?.platform ?? channelConfig.adapter,
          ...(result.call_metadata ?? {}),
          recording_url: recordingUrl,
        };
        return;
      }
    } catch (err) {
      console.warn(`live recording upload failed: ${(err as Error).message}`);
    }
  }

  let recording:
    | Awaited<ReturnType<NonNullable<typeof channel.getCallRecording>>>
    | null
    | undefined;
  try {
    recording = await channel.getCallRecording?.();
    if (!recording) return;

    const storage = getStorageClient();
    if (!storage) return;

    const baseName = slugifyRecordingLabel(result.name ?? result.caller_prompt.slice(0, 48));
    const key = `recordings/${runId}/${baseName}-${randomUUID()}.${recording.extension}`;

    await storage.upload(key, recording.body, recording.contentType);

    const recordingUrl = await buildRecordingUrl(key, storage);

    result.call_metadata = {
      platform: result.call_metadata?.platform ?? channelConfig.adapter,
      ...(result.call_metadata ?? {}),
      recording_url: recordingUrl,
    };
  } catch (err) {
    console.warn(`attachRecordingUrl failed: ${(err as Error).message}`);
  } finally {
    await recording?.cleanup?.().catch(() => {});
    await channel.discardCallRecording?.().catch(() => {});
  }
}

function buildRecordingUrl(key: string, storage: NonNullable<ReturnType<typeof createStorageClient>>): Promise<string> | string {
  const apiBaseUrl =
    process.env["API_PUBLIC_URL"]
    ?? process.env["API_URL"]
    ?? "https://vent-api.fly.dev";
  const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  if (secret) {
    return buildArtifactUrl(apiBaseUrl, createArtifactToken(key, secret));
  }
  return storage.presignDownload(key, 3600);
}

async function startRecordingUpload(
  channel: ReturnType<typeof createAudioChannel>,
  resultName: string | undefined,
  callerPrompt: string,
  runId?: string,
): Promise<ActiveRecordingUpload | null> {
  if (!runId) return null;

  const liveRecording = channel.getLiveCallRecording?.();
  if (!liveRecording) return null;

  const storage = getStorageClient();
  if (!storage) {
    await liveRecording.abort().catch(() => {});
    return null;
  }

  const baseName = slugifyRecordingLabel(resultName ?? callerPrompt.slice(0, 48));
  const key = `recordings/${runId}/${baseName}-${randomUUID()}.wav`;
  const recordingUrl = await buildRecordingUrl(key, storage);
  const multipart = await storage.createWavMultipartUpload(key);
  let aborted = false;

  const uploadPromise = (async () => {
    try {
      for await (const chunk of liveRecording.pcm) {
        await multipart.appendPcm(chunk);
      }
      if (aborted) return null;
      const totalBytes = await multipart.complete();
      return totalBytes > 0 ? recordingUrl : null;
    } catch (err) {
      if (aborted) return null;
      await multipart.abort().catch(() => {});
      throw err;
    }
  })();

  let settled = false;

  return {
    finalize: async () => {
      if (settled) return uploadPromise;
      settled = true;
      await liveRecording.finalize();
      const result = await uploadPromise;
      await liveRecording.cleanup().catch(() => {});
      return result;
    },
    abort: async () => {
      if (settled) return;
      settled = true;
      aborted = true;
      await liveRecording.abort().catch(() => {});
      await multipart.abort().catch(() => {});
      await uploadPromise.catch(() => {});
      await liveRecording.cleanup().catch(() => {});
    },
  };
}

const CONNECTION_ERROR_PATTERNS = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "WebSocket",
  "websocket",
  "connect",
  "Agent unreachable",
];

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CONNECTION_ERROR_PATTERNS.some((p) => msg.includes(p));
}

const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Run a set of concurrency-limited tasks, returning results in completion order.
 * Supports circuit breaker — if state.aborted is set, remaining tasks are skipped.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  state?: ConcurrencyState,
  onAbort?: () => T,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function next(): Promise<void> {
    while (index < tasks.length) {
      if (state?.aborted && onAbort) {
        const currentIndex = index++;
        results[currentIndex] = onAbort();
        continue;
      }
      const currentIndex = index++;
      results[currentIndex] = await tasks[currentIndex]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

export async function executeCalls(opts: ExecuteCallsOpts): Promise<ExecuteCallsResult> {
  const {
    callSpec,
    channelConfig,
    runId,
    concurrencyLimit: userConcurrency,
    onCallStart,
    onCallComplete,
  } = opts;

  // Bland uses SIP (phone calls) instead of WebSocket/WebRTC. All calls route
  // through a single Twilio number, and Bland drops later calls when 3+ are
  // active on the same destination. Cap at 3 concurrent for reliability.
  // To scale beyond 3, rotate Twilio destination numbers (number pool).
  const isBland = channelConfig.adapter === "bland";
  const concurrencyLimit = userConcurrency ?? (isBland ? 3 : 10);

  const callSpecs = callSpec.conversation_calls ?? [];
  const notifyCallComplete = async (result: ConversationCallResult) => {
    if (!onCallComplete) return;
    try {
      await onCallComplete(result);
    } catch (err) {
      console.warn(`onCallComplete failed: ${(err as Error).message}`);
    }
  };

  // Expand calls by repeat count for statistical confidence
  const allCalls = callSpecs.flatMap((spec) => {
    const repeatCount = spec.repeat ?? 1;
    return Array.from({ length: repeatCount }, () => spec);
  });

  // Pre-flight health check — only for relay/local agent runs.
  // Platform adapters (vapi, retell, elevenlabs, bland) don't need this —
  // it would waste a real API call + credits just to verify connectivity.
  // The first real call will fail with a clear error if config is wrong.
  const isPlatformAdapter = ["vapi", "retell", "elevenlabs", "bland", "livekit"].includes(channelConfig.adapter);
  if (allCalls.length > 0 && !isPlatformAdapter) {
    const probeChannel = createAudioChannel(channelConfig);
    try {
      await probeChannel.connect();
      // Hold open to verify end-to-end — if the CLI can't reach the agent,
      // the API closes this WS within ~1s (close message or buffer limit).
      await new Promise<void>((resolve, reject) => {
        const ok = setTimeout(() => {
          probeChannel.off("disconnected", onDisconnect);
          resolve();
        }, 2_000);
        function onDisconnect() {
          clearTimeout(ok);
          reject(new Error("Relay probe disconnected — CLI cannot reach local agent"));
        }
        if (!probeChannel.connected) {
          clearTimeout(ok);
          reject(new Error("Relay probe closed immediately — CLI cannot reach local agent"));
          return;
        }
        probeChannel.on("disconnected", onDisconnect);
      });
      await probeChannel.disconnect().catch(() => {});
      console.log("Pre-flight health check passed — agent is reachable.");
    } catch (err) {
      await probeChannel.disconnect().catch(() => {});
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Pre-flight health check failed: ${errorMsg}`);
      const failResult: ConversationCallResult = {
        name: "health_check",
        caller_prompt: "Pre-flight connectivity check",
        status: "error",
        transcript: [],
        duration_ms: 0,
        metrics: { mean_ttfb_ms: 0 },
        error: `Agent unreachable: ${errorMsg}`,
      };
      await notifyCallComplete(failResult);
      return {
        status: "fail" as const,
        conversationResults: [failResult],
        aggregate: {
          conversation_calls: { total: 1, passed: 0, failed: 1 },
          total_duration_ms: 0,
        },
      };
    }
  }

  // Circuit breaker state — shared across concurrent workers
  const circuitState: ConcurrencyState = {
    aborted: false,
    abortReason: null,
    consecutiveConnectionFailures: 0,
  };

  const tasks = allCalls.map((spec) => async () => {
    const callName = spec.name ?? `conversation:${spec.caller_prompt.slice(0, 50)}`;
    onCallStart?.({ call_name: callName });
    console.log(`  Conversation: ${spec.caller_prompt.slice(0, 60)}...`);

    const perCallChannelConfig: AudioChannelConfig = {
      ...channelConfig,
      runId,
      callName,
    };
    const channel = createAudioChannel(perCallChannelConfig);
    const recordingUpload = await startRecordingUpload(channel, spec.name, spec.caller_prompt, runId)
      .catch((err) => {
        console.warn(`recording upload bootstrap failed: ${(err as Error).message}`);
        return null;
      });
    const start = Date.now();
    try {
      // Per-call timeout: scales with max_turns to accommodate agents that
      // use tool calls (each turn can take 15-20s with STT → LLM → tools → TTS).
      // Minimum 120s, plus 25s per turn beyond the baseline 4 turns.
      const CALL_TIMEOUT_MS = Math.max(120_000, (spec.max_turns ?? 10) * 25_000);
      const callResult = await Promise.race([
        (async () => {
          await channel.connect();
          return await runConversationCall(spec, channel);
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(
            `Call "${callName}" timed out after ${CALL_TIMEOUT_MS / 1000}s. ` +
            `The agent may have connected but not produced audio.`
          )), CALL_TIMEOUT_MS)
        ),
      ]);
      const result = callResult;
      await attachRecordingUrl(result, channel, perCallChannelConfig, recordingUpload, runId);
      // Successful connection — reset circuit breaker counter
      circuitState.consecutiveConnectionFailures = 0;
      console.log(`    Status: ${result.status} (${result.duration_ms}ms)`);
      console.log(JSON.stringify({
        event: "call_complete", call_name: callName,
        status: result.status, duration_ms: result.duration_ms,
        channel: { bytes_sent: channel.stats.bytesSent, bytes_received: channel.stats.bytesReceived, errors: channel.stats.errorEvents },
      }));
      await notifyCallComplete(result);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`    ${callName}: error — ${errorMsg}`);

      // Circuit breaker: track consecutive connection errors
      if (isConnectionError(err)) {
        circuitState.consecutiveConnectionFailures++;
        if (circuitState.consecutiveConnectionFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          circuitState.aborted = true;
          circuitState.abortReason = `Run aborted after ${CIRCUIT_BREAKER_THRESHOLD} consecutive connection failures: ${errorMsg}`;
          console.error(`Circuit breaker tripped: ${circuitState.abortReason}`);
        }
      } else {
        // Non-connection error (eval/logic failure) — reset counter
        circuitState.consecutiveConnectionFailures = 0;
      }

      const result: ConversationCallResult = {
        name: spec.name,
        caller_prompt: spec.caller_prompt,
        status: "error",
        transcript: [],
        duration_ms: Date.now() - start,
        metrics: { mean_ttfb_ms: 0 },
        error: errorMsg,
      };
      await attachRecordingUrl(result, channel, perCallChannelConfig, recordingUpload, runId);
      console.log(JSON.stringify({
        event: "call_complete", call_name: callName,
        status: "error", duration_ms: result.duration_ms, error: errorMsg,
      }));
      await notifyCallComplete(result);
      return result;
    } finally {
      await channel.disconnect().catch(() => {});
    }
  });

  if (tasks.length > 0) {
    console.log(`Running ${tasks.length} conversation calls (concurrency: ${concurrencyLimit})...`);
  }

  // Build an abort result factory for the circuit breaker
  const makeAbortResult = (): ConversationCallResult => ({
    name: "aborted",
    caller_prompt: "Skipped — circuit breaker tripped",
    status: "error",
    transcript: [],
    duration_ms: 0,
    metrics: { mean_ttfb_ms: 0 },
    error: circuitState.abortReason ?? "Run aborted",
  });

  const results = tasks.length > 0
    ? await runWithConcurrency(tasks, concurrencyLimit, circuitState, makeAbortResult)
    : [];

  // =====================================================
  // Aggregate results
  // =====================================================
  const completed = results.filter((r) => r.status === "completed").length;
  const errored = results.filter((r) => r.status === "error").length;
  const totalDurationMs = results.reduce((sum, r) => sum + r.duration_ms, 0);

  // Sum platform costs across all calls
  const totalCostUsd = results.reduce((sum, r) => {
    const cost = r.call_metadata?.cost_usd;
    return cost != null ? sum + cost : sum;
  }, 0);

  const callCounts = { total: results.length, passed: completed, failed: errored };
  const aggregate: RunAggregateV2 = {
    conversation_calls: callCounts,
    total_duration_ms: totalDurationMs,
    ...(totalCostUsd > 0 ? { total_cost_usd: totalCostUsd } : {}),
  };

  const status = errored === 0 ? "pass" : "fail";

  console.log(
    `Run complete: ${status} (conversation: ${completed}/${results.length})`,
  );

  return {
    status,
    conversationResults: results,
    aggregate,
  };
}
