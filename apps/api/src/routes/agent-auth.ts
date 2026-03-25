import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { WorkOS } from "@workos-inc/node";
import { schema } from "@vent/db";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_STARTS = 3; // per email per window
const MAX_VERIFIES = 5; // per email per window

interface RateEntry {
  count: number;
  resetAt: number;
}

const startLimiter = new Map<string, RateEntry>();
const verifyLimiter = new Map<string, RateEntry>();

function checkRate(
  limiter: Map<string, RateEntry>,
  key: string,
  max: number,
): boolean {
  const now = Date.now();
  const entry = limiter.get(key);

  if (!entry || now >= entry.resetAt) {
    limiter.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

export async function agentAuthRoutes(app: FastifyInstance) {
  const workosApiKey = process.env["WORKOS_API_KEY"];
  const workosClientId = process.env["WORKOS_CLIENT_ID"];

  if (!workosApiKey || !workosClientId) {
    app.log.info(
      "Agent auth routes disabled — WORKOS_API_KEY and WORKOS_CLIENT_ID required.",
    );
    return;
  }

  const workos = new WorkOS(workosApiKey, { clientId: workosClientId });

  // Send a 6-digit OTP to the user's email (no auth required)
  app.post("/auth/magic-start", async (request, reply) => {
    const { email } = request.body as { email?: string };
    if (!email || typeof email !== "string") {
      return reply.status(400).send({ error: "email is required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (!checkRate(startLimiter, normalizedEmail, MAX_STARTS)) {
      return reply.status(429).send({
        error: "Too many requests. Try again in a few minutes.",
      });
    }

    try {
      await workos.userManagement.createMagicAuth({ email: normalizedEmail });
    } catch (err: any) {
      app.log.error({ err }, "Failed to create magic auth");
      return reply.status(500).send({ error: "Failed to send verification code." });
    }

    return reply.send({ success: true });
  });

  // Verify the OTP and issue an API key (no auth required)
  app.post("/auth/magic-verify", async (request, reply) => {
    const { email, code } = request.body as {
      email?: string;
      code?: string;
    };
    if (!email || typeof email !== "string") {
      return reply.status(400).send({ error: "email is required" });
    }
    if (!code || typeof code !== "string") {
      return reply.status(400).send({ error: "code is required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (!checkRate(verifyLimiter, normalizedEmail, MAX_VERIFIES)) {
      return reply.status(429).send({
        error: "Too many attempts. Try again in a few minutes.",
      });
    }

    let userId: string;
    try {
      const authResponse =
        await workos.userManagement.authenticateWithMagicAuth({
          code: code.trim(),
          email: normalizedEmail,
        });
      userId = authResponse.user.id;
    } catch (err: any) {
      app.log.warn({ err }, "Magic auth verification failed");
      return reply.status(401).send({ error: "Invalid or expired code." });
    }

    // Create API key (same pattern as device.ts and keys.ts)
    const rawKey = `vent_${randomBytes(24).toString("hex")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 12);

    await app.db.insert(schema.apiKeys).values({
      user_id: userId,
      key_hash: keyHash,
      name: "Agent Setup",
      prefix,
    });

    return reply.send({ api_key: rawKey });
  });
}
