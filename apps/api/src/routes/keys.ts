import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull, desc } from "drizzle-orm";
import { schema } from "@vent/db";

export async function keyRoutes(app: FastifyInstance) {
  const authPreHandler = { preHandler: app.verifyAuth };

  app.post("/keys", authPreHandler, async (request, reply) => {
    const body = request.body as { name?: string } | undefined;
    const name = body?.name ?? "default";

    const rawKey = `vent_${randomBytes(24).toString("hex")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 12);

    const [row] = await app.db
      .insert(schema.apiKeys)
      .values({
        user_id: request.userId!,
        key_hash: keyHash,
        name,
        prefix,
      })
      .returning();

    return reply.status(201).send({
      id: row!.id,
      api_key: rawKey,
      name,
      prefix,
      created_at: row!.created_at,
      warning: "Save this key — it will not be shown again.",
    });
  });

  app.get("/keys", authPreHandler, async (request, reply) => {
    const rows = await app.db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        prefix: schema.apiKeys.prefix,
        created_at: schema.apiKeys.created_at,
        revoked_at: schema.apiKeys.revoked_at,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.user_id, request.userId!))
      .orderBy(desc(schema.apiKeys.created_at));

    const keys = rows.map((row) => ({
      ...row,
      active: row.revoked_at === null,
    }));

    return reply.send(keys);
  });

  app.delete<{ Params: { id: string } }>(
    "/keys/:id",
    authPreHandler,
    async (request, reply) => {
      const { id } = request.params;

      const [updated] = await app.db
        .update(schema.apiKeys)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(schema.apiKeys.id, id),
            eq(schema.apiKeys.user_id, request.userId!),
            isNull(schema.apiKeys.revoked_at),
          )
        )
        .returning();

      if (!updated) {
        return reply
          .status(404)
          .send({ error: "Key not found or already revoked" });
      }

      return reply.send({ id: updated.id, revoked_at: updated.revoked_at });
    }
  );
}
