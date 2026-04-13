import { Worker } from "bullmq";
import IORedis from "ioredis";
import { writeFileSync, mkdirSync } from "node:fs";
import { WebhookServer } from "@vent/adapters";
import { executeRun } from "./jobs/run-executor.js";

const LOG_DIR = "/tmp/vent-run-logs";
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

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
        adapter?: string;
        call_spec?: Record<string, unknown>;
        voice_config?: Record<string, unknown>;
        start_command?: string;
        health_endpoint?: string;
        agent_url?: string;
        platform_connection_id?: string | null;
        agent_session_id?: string;
      };

      console.log(`[${queueName}] Processing run ${data.run_id} (adapter: ${data.adapter ?? "unknown"}${data.agent_session_id ? ", session" : ""})`);

      // Capture all console output for the run so we can dump it at the end.
      // Fly only keeps the last 100 log lines — this ensures we can see the full run.
      const logLines: string[] = [];
      const origLog = console.log;
      const origErr = console.error;
      console.log = (...args: unknown[]) => {
        const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        logLines.push(line);
        origLog.apply(console, args);
      };
      console.error = (...args: unknown[]) => {
        const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        logLines.push(`[ERROR] ${line}`);
        origErr.apply(console, args);
      };

      try {
        await executeRun({
          run_id: data.run_id,
          adapter: data.adapter,
          call_spec: data.call_spec,
          voice_config: data.voice_config,
          start_command: data.start_command,
          health_endpoint: data.health_endpoint,
          agent_url: data.agent_url,
          platform_connection_id: data.platform_connection_id ?? null,
          agent_session_id: data.agent_session_id,
        });
      } finally {
        console.log = origLog;
        console.error = origErr;
        const logPath = `${LOG_DIR}/${data.run_id}.log`;
        try {
          writeFileSync(logPath, logLines.join("\n") + "\n");
          origLog(`[run-log] Full log written to ${logPath} (${logLines.length} lines)`);
        } catch (e) {
          origErr(`[run-log] Failed to write log: ${e}`);
        }
      }
    },
    {
      connection,
      concurrency: perUserConcurrency,
      // Bland runs: 6 calls × 10s gap = 60s initiation + ~120s audio = ~180s minimum.
      // Lock must exceed the longest possible run to prevent false stall detection.
      lockDuration: 600_000,       // 10 min — covers worst-case Bland runs
      stalledInterval: 30_000,     // check every 30s (default, explicit for clarity)
      // lockRenewTime auto-set to lockDuration/2 = 300s — do not override
      maxStalledCount: 1,          // 1 retry on stall, then fail
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400, count: 5000 },
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
  // Start persistent HTTP server for Bland webhook callbacks.
  // Must listen at boot so Fly.io's proxy routes traffic to this machine.
  const webhookPort = parseInt(process.env["RUNNER_LISTEN_PORT"] ?? "0", 10);
  const webhookHost = process.env["RUNNER_PUBLIC_HOST"] ?? "";
  if (webhookPort && webhookHost) {
    await WebhookServer.startPersistentServer({
      publicHost: webhookHost,
      port: webhookPort,
      publicPort: null, // Behind Fly reverse proxy (443 → 8443)
    });
  }

  // Discover existing per-user queues from Redis Set
  const existingQueues = await connection.smembers("vent:active-queues");
  for (const queueName of existingQueues) {
    createWorkerForQueue(queueName);
  }
  console.log(`Discovered ${existingQueues.length} existing queue(s)`);

  // Subscribe to pub/sub for new queues created at runtime
  const sub = connection.duplicate();
  await sub.subscribe("vent:new-queue");
  sub.on("message", (_channel, queueName) => {
    createWorkerForQueue(queueName);
  });

  console.log(`Vent Worker started (per-user concurrency: ${perUserConcurrency}), listening for queues...`);
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
