import fp from "fastify-plugin";
import { Queue } from "bullmq";
import IORedis from "ioredis";

declare module "fastify" {
  interface FastifyInstance {
    getRunQueue: (userId: string) => Queue;
  }
}

export const queuePlugin = fp(async (app) => {
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const queues = new Map<string, Queue>();

  app.decorate("getRunQueue", (userId: string) => {
    const name = `voice-ci-runs-${userId}`;
    if (!queues.has(name)) {
      const q = new Queue(name, {
        connection,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86_400, count: 5000 },
        },
      });
      queues.set(name, q);
      // Notify worker of new queue via Redis Set + pub/sub
      void connection.sadd("vent:active-queues", name);
      void connection.publish("vent:new-queue", name);
    }
    return queues.get(name)!;
  });

  app.addHook("onClose", async () => {
    for (const q of queues.values()) {
      await q.close();
    }
    connection.disconnect();
  });
});
