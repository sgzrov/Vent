import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@vent/db";
import { PlatformConfigSchema } from "@vent/shared";
import {
  buildIdentityKey,
  buildResolvedHash,
  buildResourceLabel,
  encryptSecrets,
  splitPlatformConfig,
  toPlatformConnectionSummary,
} from "@vent/platform-connections";

const EnsurePlatformConnectionSchema = z.object({
  platform: PlatformConfigSchema,
  client_context: z.object({
    source: z.enum(["cli", "agent"]),
    repo_name: z.string().optional(),
    repo_fingerprint: z.string().optional(),
    cli_version: z.string().optional(),
  }).optional(),
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505";
}

export async function platformConnectionRoutes(app: FastifyInstance) {
  const authPreHandler = { preHandler: app.verifyAuth };

  app.post("/platform-connections/ensure", authPreHandler, async (request, reply) => {
    const parsed = EnsurePlatformConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid platform connection request",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    try {
      const { platform } = parsed.data;
      const identityKey = buildIdentityKey(platform);
      const resourceLabel = buildResourceLabel(platform);
      const resolvedHash = buildResolvedHash(platform);
      const { config, secrets, platformSummary } = splitPlatformConfig(platform);

      const [existing] = await app.db
        .select()
        .from(schema.platformConnections)
        .where(
          and(
            eq(schema.platformConnections.user_id, request.userId!),
            eq(schema.platformConnections.provider, platform.provider),
            eq(schema.platformConnections.identity_key, identityKey),
          ),
        )
        .limit(1);

      if (existing && existing.resolved_hash === resolvedHash) {
        return reply.send({
          platform_connection_id: existing.id,
          provider: existing.provider,
          identity_key: existing.identity_key,
          resource_label: existing.resource_label,
          version: existing.version,
          created: false,
          updated: false,
          platform_summary: platformSummary,
        });
      }

      const now = new Date();
      const encryptedSecrets = encryptSecrets(secrets);

      const writeExisting = async (existingRow: NonNullable<typeof existing>) => {
        const [updated] = await app.db
          .update(schema.platformConnections)
          .set({
            resource_label: resourceLabel,
            config_json: config,
            secrets_encrypted: encryptedSecrets,
            resolved_hash: resolvedHash,
            version: existingRow.version + 1,
            status: "active",
            last_verified_at: now,
            updated_at: now,
          })
          .where(eq(schema.platformConnections.id, existingRow.id))
          .returning();

        const summary = toPlatformConnectionSummary(updated!);
        return reply.send({
          platform_connection_id: summary.id,
          provider: summary.provider,
          identity_key: identityKey,
          resource_label: summary.resource_label,
          version: summary.version,
          created: false,
          updated: true,
          platform_summary: platformSummary,
        });
      };

      if (existing) {
        return writeExisting(existing);
      }

      try {
        const [created] = await app.db
          .insert(schema.platformConnections)
          .values({
            user_id: request.userId!,
            provider: platform.provider,
            identity_key: identityKey,
            resource_label: resourceLabel,
            config_json: config,
            secrets_encrypted: encryptedSecrets,
            resolved_hash: resolvedHash,
            version: 1,
            status: "active",
            last_verified_at: now,
            updated_at: now,
          })
          .returning();

        const summary = toPlatformConnectionSummary(created!);
        return reply.status(201).send({
          platform_connection_id: summary.id,
          provider: summary.provider,
          identity_key: identityKey,
          resource_label: summary.resource_label,
          version: summary.version,
          created: true,
          updated: false,
          platform_summary: platformSummary,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;

        const [racedExisting] = await app.db
          .select()
          .from(schema.platformConnections)
          .where(
            and(
              eq(schema.platformConnections.user_id, request.userId!),
              eq(schema.platformConnections.provider, platform.provider),
              eq(schema.platformConnections.identity_key, identityKey),
            ),
          )
          .limit(1);

        if (!racedExisting) throw err;

        if (racedExisting.resolved_hash === resolvedHash) {
          return reply.send({
            platform_connection_id: racedExisting.id,
            provider: racedExisting.provider,
            identity_key: racedExisting.identity_key,
            resource_label: racedExisting.resource_label,
            version: racedExisting.version,
            created: false,
            updated: false,
            platform_summary: platformSummary,
          });
        }

        return writeExisting(racedExisting);
      }
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : "Failed to ensure platform connection",
      });
    }
  });
}
