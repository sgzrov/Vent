import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  type PutObjectCommandInput,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";

export interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const MULTIPART_MIN_PART_SIZE = 5 * 1024 * 1024;
const WAV_HEADER_BYTES = 44;

export class S3Storage {
  private client: S3Client;
  private bucket: string;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
      // R2 doesn't support AWS checksum extensions — disable them
      // to prevent x-amz-checksum-mode=ENABLED in presigned URLs
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async presignUpload(
    key: string,
    contentType: string = "application/gzip",
    expiresIn: number = 3600
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async presignDownload(key: string, expiresIn: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async upload(
    key: string,
    body: Buffer | Readable | ReadableStream,
    contentType: string = "application/gzip"
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body as PutObjectCommandInput["Body"],
      ContentType: contentType,
    });
    await this.client.send(command);
  }

  async download(key: string): Promise<ReadableStream | null> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    const response = await this.client.send(command);
    return (response.Body?.transformToWebStream() as ReadableStream) ?? null;
  }

  async createWavMultipartUpload(
    key: string,
    sampleRate: number = 24_000,
    partSize: number = 8 * 1024 * 1024,
  ): Promise<WavMultipartUpload> {
    const resolvedPartSize = Math.max(partSize, MULTIPART_MIN_PART_SIZE);
    const command = new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: "audio/wav",
    });
    const response = await this.client.send(command);
    if (!response.UploadId) {
      throw new Error("Failed to create multipart upload");
    }
    return new WavMultipartUpload(this.client, this.bucket, key, response.UploadId, sampleRate, resolvedPartSize);
  }
}

export class WavMultipartUpload {
  private readonly parts = new Map<number, string>();
  private readonly head = new PendingBuffer();
  private readonly tail = new PendingBuffer();
  private readonly headTargetBytes: number;
  private readonly uploadChain = Promise.resolve();
  private pendingUpload = this.uploadChain;
  private nextPartNumber = 2;
  private totalPcmBytes = 0;
  private completed = false;
  private aborted = false;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly key: string,
    private readonly uploadId: string,
    private readonly sampleRate: number,
    private readonly partSize: number,
  ) {
    this.headTargetBytes = this.partSize - WAV_HEADER_BYTES;
  }

  async appendPcm(chunk: Buffer): Promise<void> {
    if (this.completed || this.aborted || chunk.length === 0) return;
    this.totalPcmBytes += chunk.length;

    let remaining = chunk;
    if (this.head.byteLength < this.headTargetBytes) {
      const headBytes = Math.min(this.headTargetBytes - this.head.byteLength, remaining.length);
      this.head.append(remaining.subarray(0, headBytes));
      remaining = remaining.subarray(headBytes);
    }

    if (remaining.length > 0) {
      this.tail.append(remaining);
    }

    await this.uploadReadyParts();
  }

  async complete(): Promise<number> {
    if (this.aborted) return 0;
    if (this.completed) return this.totalPcmBytes;
    this.completed = true;

    if (this.totalPcmBytes === 0) {
      await this.abort();
      return 0;
    }

    await this.uploadReadyParts();

    const headPart = Buffer.concat([
      createWavHeader(this.totalPcmBytes, this.sampleRate),
      this.head.takeAll(),
    ]);
    await this.uploadPart(1, headPart);

    const tailRemainder = this.tail.takeAll();
    if (tailRemainder.length > 0) {
      await this.uploadPart(this.nextPartNumber++, tailRemainder);
    }

    const sortedParts = Array.from(this.parts.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([PartNumber, ETag]) => ({ PartNumber, ETag }));

    const command = new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: this.key,
      UploadId: this.uploadId,
      MultipartUpload: { Parts: sortedParts },
    });
    await this.client.send(command);
    return this.totalPcmBytes;
  }

  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    await this.pendingUpload.catch(() => {});
    await this.client.send(new AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: this.key,
      UploadId: this.uploadId,
    })).catch(() => {});
  }

  private async uploadReadyParts(): Promise<void> {
    while (this.tail.byteLength >= this.partSize) {
      const part = this.tail.take(this.partSize);
      await this.uploadPart(this.nextPartNumber++, part);
    }
  }

  private async uploadPart(partNumber: number, body: Buffer): Promise<void> {
    if (body.length === 0 || this.aborted) return;

    this.pendingUpload = this.pendingUpload.then(async () => {
      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId: this.uploadId,
        PartNumber: partNumber,
        Body: body,
      });
      const response = await this.client.send(command);
      if (!response.ETag) {
        throw new Error(`Upload part ${partNumber} did not return an ETag`);
      }
      this.parts.set(partNumber, response.ETag);
    });

    await this.pendingUpload;
  }
}

class PendingBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  get byteLength(): number {
    return this.totalBytes;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  take(byteLength: number): Buffer {
    if (byteLength <= 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let remaining = Math.min(byteLength, this.totalBytes);

    while (remaining > 0 && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      if (head.length <= remaining) {
        parts.push(head);
        this.chunks.shift();
        this.totalBytes -= head.length;
        remaining -= head.length;
        continue;
      }

      parts.push(head.subarray(0, remaining));
      this.chunks[0] = head.subarray(remaining);
      this.totalBytes -= remaining;
      remaining = 0;
    }

    return Buffer.concat(parts);
  }

  takeAll(): Buffer {
    return this.take(this.totalBytes);
  }
}

function createWavHeader(dataSize: number, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  const header = Buffer.alloc(WAV_HEADER_BYTES);
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
  return header;
}
