import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull, desc } from "drizzle-orm";
import { schema } from "@vent/db";

export async function keyRoutes(app: FastifyInstance) {
  const authPreHandler = { preHandler: app.verifyAuth };
  // Mutating routes additionally enforce Origin allowlist for cookie-authed
  // requests so a malicious site can't trigger key creation/revocation via
  // an in-browser form POST against a signed-in dashboard user.
  const mutatingPreHandler = { preHandler: app.verifyAuthAndCsrf };

  app.post("/keys", mutatingPreHandler, async (request, reply) => {
    const body = request.body as { name?: string } | undefined;
    const name = body?.name ?? "default";

    const rawAccessToken = `vent_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(rawAccessToken).digest("hex");
    const prefix = rawAccessToken.slice(0, 12);

    const [row] = await app.db
      .insert(schema.accessTokens)
      .values({
        user_id: request.userId!,
        token_hash: tokenHash,
        name,
        prefix,
      })
      .returning();

    return reply.status(201).send({
      id: row!.id,
      access_token: rawAccessToken,
      name,
      prefix,
      created_at: row!.created_at,
      warning: "Save this access token — it will not be shown again.",
    });
  });

  app.get("/keys", authPreHandler, async (request, reply) => {
    const rows = await app.db
      .select({
        id: schema.accessTokens.id,
        name: schema.accessTokens.name,
        prefix: schema.accessTokens.prefix,
        created_at: schema.accessTokens.created_at,
        revoked_at: schema.accessTokens.revoked_at,
      })
      .from(schema.accessTokens)
      .where(eq(schema.accessTokens.user_id, request.userId!))
      .orderBy(desc(schema.accessTokens.created_at));

    const keys = rows.map((row) => ({
      ...row,
      active: row.revoked_at === null,
    }));

    return reply.send(keys);
  });

  app.delete<{ Params: { id: string } }>(
    "/keys/:id",
    mutatingPreHandler,
    async (request, reply) => {
      const { id } = request.params;

      const [updated] = await app.db
        .update(schema.accessTokens)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(schema.accessTokens.id, id),
            eq(schema.accessTokens.user_id, request.userId!),
            isNull(schema.accessTokens.revoked_at),
          )
        )
        .returning();

      if (!updated) {
        return reply
          .status(404)
          .send({ error: "Access token not found or already revoked" });
      }

      return reply.send({ id: updated.id, revoked_at: updated.revoked_at });
    }
  );
}
