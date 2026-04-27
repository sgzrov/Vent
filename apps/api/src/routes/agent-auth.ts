import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { schema } from "@vent/db";

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_BOOTSTRAPS_PER_IP = 5;

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
  // GitHub identity — zero-interaction account creation with verified identity.
  // Anonymous bootstrap was removed: every `vent-hq init` now requires either
  // a working GitHub token (auto) or a one-time browser sign-in via WorkOS
  // device flow (CLI fallback). No anonymous abuse vector.
  app.post("/auth/github", {
    config: {
      // Identity creation — tighter cap. Per-IP since unauthenticated.
      rateLimit: { max: 10, timeWindow: "1 hour" },
    },
  }, async (request, reply) => {
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
      const { Octokit } = await import("@octokit/rest");
      const octokit = new Octokit({ auth: github_token });
      const { data } = await octokit.rest.users.getAuthenticated();
      ghUser = { id: data.id, login: data.login };
    } catch {
      return reply
        .status(401)
        .send({ error: "GitHub token verification failed." });
    }

    const userId = `gh_${ghUser.id}`;
    const rawAccessToken = `vent_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(rawAccessToken).digest("hex");
    const prefix = rawAccessToken.slice(0, 12);

    await app.db.insert(schema.accessTokens).values({
      user_id: userId,
      token_hash: tokenHash,
      name: `GitHub (${ghUser.login})`,
      prefix,
    });

    return reply.status(201).send({
      access_token: rawAccessToken,
      username: ghUser.login,
    });
  });
}
