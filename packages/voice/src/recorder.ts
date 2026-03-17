/**
 * AudioRecorder — accumulates PCM audio chunks and tracks timing.
 */

import { BYTES_PER_SECOND } from "./types.js";
import { concatPcm } from "./format.js";

export class AudioRecorder {
  private chunks: Buffer[] = [];
  private firstChunkTime: number | null = null;
  private startTime: number;

  constructor() {
    this.startTime = performance.now();
  }

  /** Add an incoming audio chunk. */
  push(chunk: Buffer): void {
    if (this.firstChunkTime === null) {
      this.firstChunkTime = performance.now();
    }
    this.chunks.push(chunk);
  }

  /** Get the combined audio buffer. */
  getBuffer(): Buffer {
    return concatPcm(this.chunks);
  }

  /** Total audio duration in ms (based on PCM byte count at 24kHz 16-bit mono). */
  getDurationMs(): number {
    const totalBytes = this.chunks.reduce((sum, c) => sum + c.length, 0);
    return Math.round((totalBytes / BYTES_PER_SECOND) * 1000);
  }

  /** Time from recorder creation to first audio chunk received (ms). */
  getTimeToFirstByteMs(): number | null {
    if (this.firstChunkTime === null) return null;
    return Math.round(this.firstChunkTime - this.startTime);
  }

  /** Whether any audio has been received. */
  hasAudio(): boolean {
    return this.chunks.length > 0;
  }

  reset(): void {
    this.chunks = [];
    this.firstChunkTime = null;
    this.startTime = performance.now();
  }
}
