/**
 * Audio format conversion utilities.
 * Handles mulaw ↔ linear16 and sample rate conversion for Twilio Media Streams.
 */

// mulaw encoding/decoding tables
const MULAW_BIAS = 0x84;
const MULAW_MAX = 0x7fff;
const MULAW_CLIP = 32635;

/**
 * Encode a PCM 16-bit signed sample to mulaw 8-bit.
 */
function encodeMulawSample(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample = sample + MULAW_BIAS;

  let exponent = 7;
  for (
    let expMask = 0x4000;
    (sample & expMask) === 0 && exponent > 0;
    exponent--, expMask >>= 1
  ) {
    /* find exponent */
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

/**
 * Decode a mulaw 8-bit sample to PCM 16-bit signed.
 */
function decodeMulawSample(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign !== 0 ? -sample : sample;
}

/**
 * Convert PCM 16-bit linear buffer to mulaw 8-bit buffer.
 */
export function pcmToMulaw(pcm: Buffer): Buffer {
  const mulaw = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = pcm.readInt16LE(i * 2);
    mulaw[i] = encodeMulawSample(sample);
  }
  return mulaw;
}

/**
 * Convert mulaw 8-bit buffer to PCM 16-bit linear buffer.
 */
export function mulawToPcm(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = decodeMulawSample(mulaw[i]!);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

/**
 * Resample PCM 16-bit mono from one sample rate to another using linear interpolation.
 */
export function resample(
  input: Buffer,
  fromRate: number,
  toRate: number
): Buffer {
  if (fromRate === toRate) return input;

  const inputSamples = input.length / 2;
  const ratio = fromRate / toRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, inputSamples - 1);
    const frac = srcIndex - srcFloor;

    const a = input.readInt16LE(srcFloor * 2);
    const b = input.readInt16LE(srcCeil * 2);
    const sample = Math.round(a + (b - a) * frac);
    output.writeInt16LE(
      Math.max(-32768, Math.min(32767, sample)),
      i * 2
    );
  }

  return output;
}

/**
 * Wrap raw PCM 16-bit signed mono data in a WAV container.
 * Required for APIs (like Hume) that don't accept raw PCM.
 */
export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
