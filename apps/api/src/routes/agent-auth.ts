import type { FastifyInstance } from "fastify";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { schema } from "@vent/db";

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_BOOTSTRAPS_PER_IP = 5;
const DEFAULT_RUN_LIMIT = 10;

interface RateEntry {
  count: number;
  resetAt: number;
}

const ipLimiter = new Map<string, RateEntry>();

function checkRate(ip: string): boolean {
  const now = Date.now();
  const entry = ipLimiter.get(ip);

  if (!entry || now >= entry.resetAt) {
    ipLimiter.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (entry.count >= MAX_BOOTSTRAPS_PER_IP) return false;
  entry.count++;
  return true;
}

export async function agentAuthRoutes(app: FastifyInstance) {
  // Anonymous bootstrap — zero-interaction account creation for agents
  app.post("/auth/bootstrap", async (request, reply) => {
    const ip = request.ip;

    if (!checkRate(ip)) {
      return reply.status(429).send({
        error: "Too many accounts created. Try again later.",
      });
    }

    const runLimit =
      parseInt(process.env["ANONYMOUS_RUN_LIMIT"] ?? "", 10) ||
      DEFAULT_RUN_LIMIT;

    const userId = `anon_${randomUUID()}`;
    const rawKey = `vent_${randomBytes(24).toString("hex")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 12);

    await app.db.insert(schema.apiKeys).values({
      user_id: userId,
      key_hash: keyHash,
      name: "Bootstrap",
      prefix,
      is_anonymous: true,
      run_limit: runLimit,
    });

    return reply.status(201).send({
      api_key: rawKey,
      run_limit: runLimit,
    });
  });
}
