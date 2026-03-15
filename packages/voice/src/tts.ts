/**
 * Deepgram Aura-2 TTS — converts text to PCM 16-bit 24kHz mono audio.
 */

import { createClient, DeepgramApiError } from "@deepgram/sdk";
import { withRetry } from "@vent/shared";

const DEFAULT_MODEL = "aura-2-thalia-en";

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface TTSConfig {
  voiceId?: string;
  apiKeyEnv?: string;
}

export async function synthesize(
  text: string,
  config?: TTSConfig
): Promise<Buffer> {
  if (!text.trim()) {
    return Buffer.alloc(0);
  }

  const apiKey = process.env[config?.apiKeyEnv ?? "DEEPGRAM_API_KEY"];
  if (!apiKey) {
    throw new Error(
      `Missing Deepgram API key (env: ${config?.apiKeyEnv ?? "DEEPGRAM_API_KEY"})`
    );
  }

  const model = config?.voiceId ?? DEFAULT_MODEL;
  const deepgram = createClient(apiKey);

  const response = await withRetry(async () => {
    try {
      const speakClient = await deepgram.speak.request(
        { text },
        {
          model,
          encoding: "linear16",
          container: "none",
          sample_rate: 24000,
        },
      );

      if (!speakClient.result) {
        throw Object.assign(new Error("Deepgram TTS returned empty response"), {
          retryable: true,
        });
      }
      return speakClient.result;
    } catch (err) {
      if (err instanceof DeepgramApiError) {
        if (isRetryableStatus(err.status)) {
          throw Object.assign(
            new Error(`Deepgram TTS retryable (${err.status})`),
            { retryable: true },
          );
        }
        throw new Error(`Deepgram TTS failed (${err.status}): ${err.message}`);
      }

      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`Deepgram TTS transient error: ${msg}`), {
        retryable: true,
      });
    }
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
