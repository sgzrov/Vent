import { Worker } from "bullmq";
import IORedis from "ioredis";
import type { PlatformConfig } from "@voiceci/shared";
import { executeRun } from "./jobs/run-executor.js";

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const perUserConcurrency = parseInt(process.env["PER_USER_CONCURRENCY"] ?? "5", 10);

// Per-user workers: each API key gets its own queue with independent concurrency
const workers = new Map<string, Worker>();

function createWorkerForQueue(queueName: string) {
  if (workers.has(queueName)) return;

  const worker = new Worker(
    queueName,
    async (job) => {
      const data = job.data as {
        run_id: string;
        bundle_key: string | null;
        bundle_hash: string | null;
        lockfile_hash?: string | null;
        adapter?: string;
        test_spec?: Record<string, unknown>;
        target_phone_number?: string;
        voice_config?: Record<string, unknown>;
        start_command?: string;
        health_endpoint?: string;
        agent_url?: string;
        platform?: Record<string, unknown> | null;
      };

      console.log(`[${queueName}] Processing run ${data.run_id} (adapter: ${data.adapter ?? "unknown"})`);
      await executeRun({
        run_id: data.run_id,
        bundle_key: data.bundle_key,
        bundle_hash: data.bundle_hash,
        lockfile_hash: data.lockfile_hash ?? null,
        adapter: data.adapter,
        test_spec: data.test_spec,
        target_phone_number: data.target_phone_number,
        voice_config: data.voice_config,
        start_command: data.start_command,
        health_endpoint: data.health_endpoint,
        agent_url: data.agent_url,
        platform: data.platform as PlatformConfig | null,
      });
    },
    {
      connection,
      concurrency: perUserConcurrency,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[${queueName}] Run ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[${queueName}] Run ${job?.id} failed:`, err.message);
  });

  workers.set(queueName, worker);
  console.log(`Worker listening on queue: ${queueName} (concurrency: ${perUserConcurrency})`);
}

async function start() {
  // Discover existing per-user queues from Redis Set
  const existingQueues = await connection.smembers("voiceci:active-queues");
  for (const queueName of existingQueues) {
    createWorkerForQueue(queueName);
  }
  console.log(`Discovered ${existingQueues.length} existing queue(s)`);

  // Subscribe to pub/sub for new queues created at runtime
  const sub = connection.duplicate();
  await sub.subscribe("voiceci:new-queue");
  sub.on("message", (_channel, queueName) => {
    createWorkerForQueue(queueName);
  });

  console.log(`VoiceCI Worker started (per-user concurrency: ${perUserConcurrency}), listening for queues...`);
}

start().catch((err) => {
  console.error("Failed to start worker:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down worker...");
  for (const worker of workers.values()) {
    await worker.close();
  }
  connection.disconnect();
  process.exit(0);
});
