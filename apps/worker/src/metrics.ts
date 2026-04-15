import http from "node:http";
import { Queue } from "bullmq";
import type IORedis from "ioredis";
import {
  Counter,
  Gauge,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export interface WorkerMetrics {
  observeQueue(queueName: string): void;
  forgetQueue(queueName: string): void;
  onJobStart(): void;
  onJobFinish(): void;
  setHotQueues(count: number): void;
  setOwnedQueues(count: number): void;
  setLocalQueueWorkers(count: number): void;
  close(): Promise<void>;
}

interface WorkerMetricsOptions {
  connection: IORedis;
  metricsPort: number;
  totalConcurrency: number;
}

const SCRAPE_INTERVAL_MS = 5_000;

export function createWorkerMetrics(opts: WorkerMetricsOptions): WorkerMetrics {
  const { connection, metricsPort, totalConcurrency } = opts;
  const register = new Registry();
  collectDefaultMetrics({ register });

  const queueObjects = new Map<string, Queue>();
  let scrapeTimer: ReturnType<typeof setInterval> | null = null;
  let scrapePromise: Promise<void> | null = null;

  const configuredTotalConcurrency = new Gauge({
    name: "vent_worker_configured_total_concurrency",
    help: "Configured total active run budget for this worker machine.",
    registers: [register],
  });
  configuredTotalConcurrency.set(totalConcurrency);

  const knownQueues = new Gauge({
    name: "vent_worker_known_queues",
    help: "Per-user BullMQ queues currently discovered by this worker process.",
    registers: [register],
  });

  const localRunningJobs = new Gauge({
    name: "vent_worker_local_running_jobs",
    help: "Runs currently executing on this worker process.",
    registers: [register],
  });

  const localQueueWorkers = new Gauge({
    name: "vent_worker_local_queue_workers",
    help: "Per-user BullMQ workers currently active on this machine.",
    registers: [register],
  });

  const ownedQueues = new Gauge({
    name: "vent_worker_owned_queues",
    help: "Hot per-user queues currently assigned to this machine.",
    registers: [register],
  });

  const hotQueues = new Gauge({
    name: "vent_worker_hot_queues",
    help: "Recently active per-user queues currently tracked by this machine.",
    registers: [register],
  });

  const queueWaitingJobs = new Gauge({
    name: "vent_worker_queue_waiting_jobs",
    help: "Global waiting jobs across all known BullMQ queues. Every worker reports the same total; use max(), not sum(), in Prometheus queries.",
    registers: [register],
  });

  const queueActiveJobs = new Gauge({
    name: "vent_worker_queue_active_jobs",
    help: "Global active jobs across all known BullMQ queues. Every worker reports the same total; use max(), not sum(), in Prometheus queries.",
    registers: [register],
  });

  const queueDelayedJobs = new Gauge({
    name: "vent_worker_queue_delayed_jobs",
    help: "Global delayed jobs across all known BullMQ queues. Every worker reports the same total; use max(), not sum(), in Prometheus queries.",
    registers: [register],
  });

  const queueBacklogJobs = new Gauge({
    name: "vent_worker_queue_backlog_jobs",
    help: "Global backlog across all known BullMQ queues (wait + prioritized + waiting-children). Every worker reports the same total; use max(), not sum(), in Prometheus queries.",
    registers: [register],
  });

  const finishedJobs = new Counter({
    name: "vent_worker_jobs_finished_total",
    help: "Runs finished on this worker process.",
    registers: [register],
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (url.pathname !== "/metrics") {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      await refreshQueueMetrics();
      res.writeHead(200, { "Content-Type": register.contentType });
      res.end(await register.metrics());
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`metrics error: ${(err as Error).message}`);
    }
  });

  server.listen(metricsPort, "0.0.0.0");

  async function refreshQueueMetrics(): Promise<void> {
    if (scrapePromise) {
      await scrapePromise;
      return;
    }

    scrapePromise = (async () => {
      knownQueues.set(queueObjects.size);

      let waiting = 0;
      let active = 0;
      let delayed = 0;
      let backlog = 0;

      for (const queue of queueObjects.values()) {
        const counts = await queue.getJobCounts(
          "wait",
          "active",
          "delayed",
          "prioritized",
          "waiting-children",
        );
        waiting += counts.wait ?? 0;
        active += counts.active ?? 0;
        delayed += counts.delayed ?? 0;
        backlog += (counts.wait ?? 0) + (counts.prioritized ?? 0) + (counts["waiting-children"] ?? 0);
      }

      queueWaitingJobs.set(waiting);
      queueActiveJobs.set(active);
      queueDelayedJobs.set(delayed);
      queueBacklogJobs.set(backlog);
    })();

    try {
      await scrapePromise;
    } finally {
      scrapePromise = null;
    }
  }

  void refreshQueueMetrics();
  scrapeTimer = setInterval(() => {
    void refreshQueueMetrics().catch((err) => {
      console.warn(`[metrics] Failed to refresh queue metrics: ${(err as Error).message}`);
    });
  }, SCRAPE_INTERVAL_MS);

  return {
    observeQueue(queueName: string) {
      if (queueObjects.has(queueName)) return;
      queueObjects.set(queueName, new Queue(queueName, { connection }));
      knownQueues.set(queueObjects.size);
      void refreshQueueMetrics();
    },
    forgetQueue(queueName: string) {
      const queue = queueObjects.get(queueName);
      if (!queue) return;
      queueObjects.delete(queueName);
      knownQueues.set(queueObjects.size);
      void queue.close().catch(() => {});
      void refreshQueueMetrics();
    },
    onJobStart() {
      localRunningJobs.inc();
    },
    onJobFinish() {
      localRunningJobs.dec();
      finishedJobs.inc();
    },
    setHotQueues(count: number) {
      hotQueues.set(count);
    },
    setOwnedQueues(count: number) {
      ownedQueues.set(count);
    },
    setLocalQueueWorkers(count: number) {
      localQueueWorkers.set(count);
    },
    async close() {
      if (scrapeTimer) clearInterval(scrapeTimer);
      await Promise.allSettled(Array.from(queueObjects.values(), (queue) => queue.close()));
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}
