import { S3Storage } from "./s3.js";
import type { StorageConfig } from "./s3.js";

export type { StorageConfig } from "./s3.js";
export { S3Storage } from "./s3.js";

export function createStorageClient(config?: Partial<StorageConfig>): S3Storage {
  const fullConfig: StorageConfig = {
    endpoint: config?.endpoint ?? process.env["S3_ENDPOINT"] ?? "",
    bucket: config?.bucket ?? process.env["S3_BUCKET"] ?? "vent-bundles",
    accessKeyId: config?.accessKeyId ?? process.env["S3_ACCESS_KEY_ID"] ?? "",
    secretAccessKey:
      config?.secretAccessKey ?? process.env["S3_SECRET_ACCESS_KEY"] ?? "",
    region: config?.region ?? process.env["S3_REGION"] ?? "auto",
  };

  if (!fullConfig.endpoint) {
    throw new Error("S3_ENDPOINT is required");
  }

  return new S3Storage(fullConfig);
}
