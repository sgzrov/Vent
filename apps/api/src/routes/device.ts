import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull, gt } from "drizzle-orm";
import { schema } from "@vent/db";

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SAFE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O/I/1/L

function generateUserCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes)
    .map((b) => SAFE_ALPHABET[b % SAFE_ALPHABET.length])
    .join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export async function deviceRoutes(app: FastifyInstance) {
  const dashboardUrl =
    process.env["DASHBOARD_URL"]!;

  // Start a device authorization session (no auth required)
  app.post("/device/start", {
    config: { rateLimit: { max: 20, timeWindow: "5 minutes" } },
  }, async (_request, reply) => {
    const sessionId = randomBytes(32).toString("hex");
    const userCode = generateUserCode();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await app.db.insert(schema.deviceSessions).values({
      session_id: sessionId,
      user_code: userCode,
      expires_at: expiresAt,
    });

    return reply.status(201).send({
      session_id: sessionId,
      user_code: userCode,
      verification_url: `${dashboardUrl}/auth/device?code=${userCode}`,
      expires_at: expiresAt.toISOString(),
    });
  });

  // Poll for authorization result (no auth required)
  app.post("/device/exchange", {
    // CLI polls every ~2s for up to ~15 min; cap generously but bounded.
    config: { rateLimit: { max: 600, timeWindow: "5 minutes" } },
  }, async (request, reply) => {
    const { session_id } = request.body as { session_id?: string };
    if (!session_id) {
      return reply.status(400).send({ error: "session_id is required" });
    }

    const [session] = await app.db
      .select()
      .from(schema.deviceSessions)
      .where(eq(schema.deviceSessions.session_id, session_id))
      .limit(1);

    if (!session) {
      return reply.send({ status: "invalid" });
    }

    if (session.expires_at < new Date()) {
      return reply.send({ status: "expired" });
    }

    if (session.consumed_at) {
      return reply.send({ status: "consumed" });
    }

    if (!session.user_id || !session.raw_access_token) {
      return reply.send({ status: "pending" });
    }

    // Approved — atomically consume the session and capture the token. The
    // UPDATE … WHERE consumed_at IS NULL RETURNING guarantees only one
    // concurrent /device/exchange poll claims the token; the loser sees
    // an empty rowcount and reports "consumed" instead of leaking a
    // duplicate token to a second client.
    const claimed = await app.db
      .update(schema.deviceSessions)
      .set({ consumed_at: new Date(), raw_access_token: null })
      .where(
        and(
          eq(schema.deviceSessions.id, session.id),
          isNull(schema.deviceSessions.consumed_at),
        ),
      )
      .returning({ token: schema.deviceSessions.raw_access_token });

    if (claimed.length === 0) {
      return reply.send({ status: "consumed" });
    }

    // The UPDATE returns the row's value AFTER the SET, which is null. Use
    // the token we read pre-UPDATE — safe because the row lock guaranteed
    // we're the one who claimed it.
    return reply.send({
      status: "approved",
      access_token: session.raw_access_token,
    });
  });

  // Approve a device session (authenticated — called by dashboard, so cookie-
  // authed; CSRF Origin check applies in addition to auth).
  const mutatingPreHandler = { preHandler: app.verifyAuthAndCsrf };

  app.post("/device/approve", {
    ...mutatingPreHandler,
    // Tight cap because user_code is only ~39 bits of entropy. With 10
    // attempts per 5 min per authed user (and a 15-min code TTL), brute-
    // forcing any pending session is infeasible.
    config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
  }, async (request, reply) => {
    const { user_code } = request.body as { user_code?: string };
    if (!user_code) {
      return reply.status(400).send({ error: "user_code is required" });
    }

    const [session] = await app.db
      .select()
      .from(schema.deviceSessions)
      .where(
        and(
          eq(schema.deviceSessions.user_code, user_code),
          isNull(schema.deviceSessions.user_id),
          isNull(schema.deviceSessions.consumed_at),
          gt(schema.deviceSessions.expires_at, new Date()),
        ),
      )
      .limit(1);

    if (!session) {
      return reply
        .status(404)
        .send({ error: "Invalid or expired device code" });
    }

    // Create access token (same pattern as keys.ts)
    const rawAccessToken = `vent_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(rawAccessToken).digest("hex");
    const prefix = rawAccessToken.slice(0, 12);

    const [accessTokenRow] = await app.db
      .insert(schema.accessTokens)
      .values({
        user_id: request.userId!,
        token_hash: tokenHash,
        name: "Vent CLI Login",
        prefix,
      })
      .returning();

    // Mark session as approved with the raw access token for CLI to pick up
    await app.db
      .update(schema.deviceSessions)
      .set({
        user_id: request.userId!,
        access_token_id: accessTokenRow!.id,
        raw_access_token: rawAccessToken,
      })
      .where(eq(schema.deviceSessions.id, session.id));

    return reply.send({ success: true });
  });
}
