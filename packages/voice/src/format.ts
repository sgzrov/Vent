/**
 * Audio format conversion utilities.
 * Handles sample rate conversion and PCM/WAV encoding.
 */

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

/**
 * Concatenate PCM Int16LE chunks into a single aligned buffer.
 * WebSocket frames are not guaranteed to be sample-aligned (RFC 6455 §5.4),
 * so the concatenated result may have an odd byte count. This function
 * truncates the trailing byte to maintain Int16LE alignment.
 */
export function concatPcm(chunks: Buffer[]): Buffer {
  const buf = Buffer.concat(chunks);
  return buf.length % 2 !== 0 ? buf.subarray(0, buf.length - 1) : buf;
}
