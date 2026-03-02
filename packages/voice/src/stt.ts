/**
 * Deepgram STT — transcribes PCM 16-bit 24kHz mono audio to text.
 */

import { createClient, DeepgramApiError } from "@deepgram/sdk";
import type { TranscriptionResult } from "./types.js";
import { withRetry } from "@voiceci/shared";

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface STTConfig {
  apiKeyEnv?: string;
  sampleRate?: number;
}

export async function transcribe(
  audio: Buffer,
  config?: STTConfig
): Promise<TranscriptionResult> {
  const apiKey = process.env[config?.apiKeyEnv ?? "DEEPGRAM_API_KEY"];
  if (!apiKey) {
    throw new Error(
      `Missing Deepgram API key (env: ${config?.apiKeyEnv ?? "DEEPGRAM_API_KEY"})`
    );
  }

  const sampleRate = config?.sampleRate ?? 24000;
  const deepgram = createClient(apiKey);

  const data = await withRetry(async () => {
    let response;
    try {
      response = await deepgram.listen.prerecorded.transcribeFile(audio, {
        encoding: "linear16",
        sample_rate: sampleRate,
        channels: 1,
      });
    } catch (err) {
      if (err instanceof DeepgramApiError) {
        if (isRetryableStatus(err.status)) {
          throw Object.assign(
            new Error(`Deepgram STT retryable (${err.status})`),
            { retryable: true },
          );
        }
        throw new Error(`Deepgram STT failed (${err.status}): ${err.message}`);
      }

      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`Deepgram STT transient error: ${msg}`), {
        retryable: true,
      });
    }

    if (response.error) {
      if (response.error instanceof DeepgramApiError) {
        if (isRetryableStatus(response.error.status)) {
          throw Object.assign(
            new Error(`Deepgram STT retryable (${response.error.status})`),
            { retryable: true },
          );
        }
        throw new Error(
          `Deepgram STT failed (${response.error.status}): ${response.error.message}`,
        );
      }

      throw Object.assign(
        new Error(`Deepgram STT transient error: ${response.error.message}`),
        { retryable: true },
      );
    }

    return response.result;
  });

  const alt = data.results?.channels?.[0]?.alternatives?.[0];

  return {
    text: alt?.transcript ?? "",
    confidence: alt?.confidence ?? 0,
  };
}
