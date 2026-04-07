/**
 * Single call execution — runs one conversation call against a voice agent.
 * Audio quality analysis and latency drift are integrated
 * into the call (no standalone infrastructure probes).
 */

import { randomUUID } from "node:crypto";
import type {
  ConversationCallSpec,
  ConversationCallResult,
  RunAggregateV2,
} from "@vent/shared";
import { buildArtifactUrl, createArtifactToken, createStorageClient } from "@vent/artifacts";
import { createAudioChannel, type AudioChannelConfig } from "@vent/adapters";
import { runConversationCall } from "./conversation/index.js";

export interface CallStartInfo {
  call_name: string;
}

export interface ExecuteCallOpts {
  callSpec: ConversationCallSpec;
  channelConfig: AudioChannelConfig;
  runId?: string;
  onCallStart?: (info: CallStartInfo) => void;
  onCallComplete?: (result: ConversationCallResult) => void | Promise<void>;
}

export interface ExecuteCallResult {
  status: "pass" | "fail";
  conversationResult: ConversationCallResult;
  aggregate: RunAggregateV2;
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

function usesVentOwnedRecording(adapter: AudioChannelConfig["adapter"]): boolean {
  return adapter === "livekit" || adapter === "websocket";
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

  const preferVentOwnedRecording = usesVentOwnedRecording(channelConfig.adapter);

  if (!preferVentOwnedRecording) {
    await activeUpload?.abort().catch(() => {});

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

export async function executeCall(opts: ExecuteCallOpts): Promise<ExecuteCallResult> {
  const {
    callSpec: spec,
    channelConfig,
    runId,
    onCallStart,
    onCallComplete,
  } = opts;

  const notifyCallComplete = async (result: ConversationCallResult) => {
    if (!onCallComplete) return;
    try {
      await onCallComplete(result);
    } catch (err) {
      console.warn(`onCallComplete failed: ${(err as Error).message}`);
    }
  };

  // Pre-flight health check — only for relay/local agent runs.
  // Platform adapters (vapi, retell, elevenlabs, bland) don't need this —
  // it would waste a real API call + credits just to verify connectivity.
  // The first real call will fail with a clear error if config is wrong.
  const isPlatformAdapter = ["vapi", "retell", "elevenlabs", "bland", "livekit"].includes(channelConfig.adapter);
  if (!isPlatformAdapter) {
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
        status: "fail",
        conversationResult: failResult,
        aggregate: {
          conversation_calls: { total: 1, passed: 0, failed: 1 },
          total_duration_ms: 0,
        },
      };
    }
  }

  // Execute the single call
  const callName = spec.name ?? `conversation:${spec.caller_prompt.slice(0, 50)}`;
  onCallStart?.({ call_name: callName });
  console.log(`  Conversation: ${spec.caller_prompt.slice(0, 60)}...`);

  const perCallChannelConfig: AudioChannelConfig = {
    ...channelConfig,
    runId,
    callName,
  };
  const channel = createAudioChannel(perCallChannelConfig);
  const recordingUpload = usesVentOwnedRecording(perCallChannelConfig.adapter)
    ? await startRecordingUpload(channel, spec.name, spec.caller_prompt, runId)
      .catch((err) => {
        console.warn(`recording upload bootstrap failed: ${(err as Error).message}`);
        return null;
      })
    : null;
  const start = Date.now();

  let result: ConversationCallResult;

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
    result = callResult;
    await attachRecordingUrl(result, channel, perCallChannelConfig, recordingUpload, runId);
    console.log(`    Status: ${result.status} (${result.duration_ms}ms)`);
    console.log(JSON.stringify({
      event: "call_complete", call_name: callName,
      status: result.status, duration_ms: result.duration_ms,
      channel: { bytes_sent: channel.stats.bytesSent, bytes_received: channel.stats.bytesReceived, errors: channel.stats.errorEvents },
    }));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`    ${callName}: error — ${errorMsg}`);

    result = {
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
  } finally {
    await channel.disconnect().catch(() => {});
  }

  await notifyCallComplete(result);

  const passed = result.status === "completed" ? 1 : 0;
  const failed = result.status === "error" ? 1 : 0;
  const costUsd = result.call_metadata?.cost_usd;

  const aggregate: RunAggregateV2 = {
    conversation_calls: { total: 1, passed, failed },
    total_duration_ms: result.duration_ms,
    ...(costUsd != null && costUsd > 0 ? { total_cost_usd: costUsd } : {}),
  };

  const status = failed === 0 ? "pass" : "fail";

  console.log(`Run complete: ${status}`);

  return {
    status,
    conversationResult: result,
    aggregate,
  };
}
