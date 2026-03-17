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
    process.env["DASHBOARD_URL"] || "https://ventmcp.dev";

  // Start a device authorization session (no auth required)
  app.post("/device/start", async (_request, reply) => {
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
  app.post("/device/exchange", async (request, reply) => {
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

    if (!session.user_id || !session.raw_api_key) {
      return reply.send({ status: "pending" });
    }

    // Approved — deliver the key and consume the session
    await app.db
      .update(schema.deviceSessions)
      .set({ consumed_at: new Date(), raw_api_key: null })
      .where(eq(schema.deviceSessions.id, session.id));

    return reply.send({ status: "approved", api_key: session.raw_api_key });
  });

  // Approve a device session (authenticated — called by dashboard)
  const authPreHandler = { preHandler: app.verifyAuth };

  app.post("/device/approve", authPreHandler, async (request, reply) => {
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

    // Create API key (same pattern as keys.ts)
    const rawKey = `vent_${randomBytes(24).toString("hex")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 12);

    const [keyRow] = await app.db
      .insert(schema.apiKeys)
      .values({
        user_id: request.userId!,
        key_hash: keyHash,
        name: "CLI Login",
        prefix,
      })
      .returning();

    // Mark session as approved with the raw key for CLI to pick up
    await app.db
      .update(schema.deviceSessions)
      .set({
        user_id: request.userId!,
        api_key_id: keyRow!.id,
        raw_api_key: rawKey,
      })
      .where(eq(schema.deviceSessions.id, session.id));

    return reply.send({ success: true });
  });
}
