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

  // GitHub identity — zero-interaction account creation with verified identity
  app.post("/auth/github", async (request, reply) => {
    const ip = request.ip;

    if (!checkRate(ip)) {
      return reply.status(429).send({
        error: "Too many accounts created. Try again later.",
      });
    }

    const { github_token } = request.body as { github_token?: string };
    if (!github_token) {
      return reply.status(400).send({ error: "github_token is required." });
    }

    // Verify token against GitHub API (server-side)
    let ghUser: { id: number; login: string };
    try {
      const ghRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${github_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "vent-api",
        },
      });

      if (!ghRes.ok) {
        return reply
          .status(401)
          .send({ error: "GitHub token verification failed." });
      }

      ghUser = (await ghRes.json()) as { id: number; login: string };
    } catch {
      return reply
        .status(502)
        .send({ error: "Could not verify GitHub token. Try again." });
    }

    if (!ghUser.id || !ghUser.login) {
      return reply
        .status(401)
        .send({ error: "GitHub token verification failed." });
    }

    const userId = `gh_${ghUser.id}`;
    const rawKey = `vent_${randomBytes(24).toString("hex")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 12);

    await app.db.insert(schema.apiKeys).values({
      user_id: userId,
      key_hash: keyHash,
      name: `GitHub (${ghUser.login})`,
      prefix,
      is_anonymous: false,
      run_limit: null,
    });

    return reply.status(201).send({
      api_key: rawKey,
      username: ghUser.login,
    });
  });
}
