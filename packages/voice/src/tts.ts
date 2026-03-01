/**
 * Deepgram Aura-2 TTS — converts text to PCM 16-bit 24kHz mono audio.
 */

import { withRetry } from "@voiceci/shared";

const DEEPGRAM_BASE_URL = "https://api.deepgram.com/v1";
const DEFAULT_MODEL = "aura-2-thalia-en";

export interface TTSConfig {
  voiceId?: string;
  apiKeyEnv?: string;
}

export async function synthesize(
  text: string,
  config?: TTSConfig
): Promise<Buffer> {
  const apiKey = process.env[config?.apiKeyEnv ?? "DEEPGRAM_API_KEY"];
  if (!apiKey) {
    throw new Error(
      `Missing Deepgram API key (env: ${config?.apiKeyEnv ?? "DEEPGRAM_API_KEY"})`
    );
  }

  const model = config?.voiceId ?? DEFAULT_MODEL;
  const url = `${DEEPGRAM_BASE_URL}/speak?model=${model}&encoding=linear16&container=none&sample_rate=24000`;

  const res = await withRetry(async () => {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!r.ok) {
      if (r.status === 408 || r.status === 429 || r.status >= 500) {
        throw Object.assign(
          new Error(`Deepgram TTS retryable (${r.status})`),
          { retryable: true },
        );
      }
      const errorText = await r.text();
      throw new Error(`Deepgram TTS failed (${r.status}): ${errorText}`);
    }
    return r;
  });

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
