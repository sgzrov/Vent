/**
 * Signal generation and analysis utilities for audio tests.
 * All audio is 16-bit signed PCM, 24kHz mono.
 */

const SAMPLE_RATE = 24000;

/**
 * Generate silence as PCM 16-bit buffer.
 */
export function generateSilence(durationMs: number): Buffer {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  return Buffer.alloc(numSamples * 2);
}

/**
 * Compute RMS energy of a PCM 16-bit buffer.
 */
export function rmsEnergy(pcm: Buffer): number {
  const samples = bufferToSamples(pcm);
  if (samples.length === 0) return 0;

  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/**
 * Check if a PCM buffer contains non-trivial audio (above noise floor).
 */
export function hasAudio(pcm: Buffer, threshold = 200): boolean {
  return rmsEnergy(pcm) > threshold;
}

function bufferToSamples(buf: Buffer): Int16Array {
  return new Int16Array(
    buf.buffer,
    buf.byteOffset,
    buf.length / 2
  );
}
