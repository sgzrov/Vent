import fp from "fastify-plugin";
import { createHash } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { schema } from "@vent/db";
import { WorkOS } from "@workos-inc/node";

declare module "fastify" {
  interface FastifyInstance {
    verifyApiKey: (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
    verifyAuth: (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    apiKeyId?: string;
    userId?: string;
    authMethod?: "api_key" | "session";
  }
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export const authPlugin = fp(async (app) => {
  const workosApiKey = process.env["WORKOS_API_KEY"];
  const workosClientId = process.env["WORKOS_CLIENT_ID"];
  const cookiePassword = process.env["WORKOS_COOKIE_PASSWORD"];
  const workosEnabled =
    !!workosApiKey && !!workosClientId && !!cookiePassword;

  if (!workosEnabled) {
    const anyWorkosConfigured =
      !!workosApiKey || !!workosClientId || !!cookiePassword;
    if (anyWorkosConfigured) {
      app.log.warn(
        "WorkOS auth is partially configured. Session auth is disabled until WORKOS_API_KEY, WORKOS_CLIENT_ID, and WORKOS_COOKIE_PASSWORD are all set.",
      );
    } else {
      app.log.info("WorkOS auth is not configured. API key auth remains enabled.");
    }
  }

  const workos = workosEnabled
    ? new WorkOS(workosApiKey, { clientId: workosClientId })
    : null;

  async function tryAuthenticateApiKey(
    request: any,
    reply: any,
    rejectNonBearer: boolean,
  ): Promise<"ok" | "none" | "invalid"> {
    const authHeader = request.headers["authorization"];
    if (!authHeader) return "none";
    if (!authHeader.startsWith("Bearer ")) {
      if (!rejectNonBearer) return "none";
      await reply.status(401).send({
        error: "Invalid authorization header. Expected 'Bearer <api_key>'.",
      });
      return "invalid";
    }

    const rawKey = authHeader.slice(7).trim();
    if (!rawKey) {
      await reply.status(401).send({ error: "Missing API key value." });
      return "invalid";
    }

    const keyHash = hashKey(rawKey);

    const [found] = await app.db
      .select()
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.key_hash, keyHash),
          isNull(schema.apiKeys.revoked_at),
        ),
      )
      .limit(1);

    if (!found) {
      await reply.status(401).send({ error: "Invalid API key" });
      return "invalid";
    }

    request.apiKeyId = found.id;
    request.userId = found.user_id;
    request.authMethod = "api_key";
    return "ok";
  }

  async function verifyApiKey(request: any, reply: any) {
    const apiKeyAuth = await tryAuthenticateApiKey(request, reply, true);
    if (apiKeyAuth === "ok" || apiKeyAuth === "invalid") return;
    await reply.status(401).send({
      error: "Missing authentication. Provide a Bearer API key.",
    });
  }

  async function verifyAuth(request: any, reply: any) {
    // Path 1: Bearer API key (CLI)
    const apiKeyAuth = await tryAuthenticateApiKey(request, reply, false);
    if (apiKeyAuth === "ok" || apiKeyAuth === "invalid") {
      return;
    }

    // Path 2: WorkOS sealed session cookie (dashboard)
    const sessionCookie = request.cookies?.["wos-session"];
    if (sessionCookie) {
      if (!workos || !cookiePassword) {
        await reply.status(401).send({
          error: "Session authentication is not configured on this API server. Provide a Bearer API key.",
        });
        return;
      }

      try {
        const session = workos.userManagement.loadSealedSession({
          sessionData: sessionCookie,
          cookiePassword,
        });

        const authResult = await session.authenticate();

        if (authResult.authenticated) {
          request.userId = authResult.user.id;
          request.authMethod = "session";
          return;
        }

        // Access token expired — try refreshing via WorkOS API
        const refreshResult = await session.refresh();
        if (refreshResult.authenticated && refreshResult.sealedSession) {
          // Send refreshed cookie back through the proxy
          reply.header(
            "Set-Cookie",
            `wos-session=${refreshResult.sealedSession}; Path=/; HttpOnly; Secure; SameSite=Lax`
          );

          // Re-authenticate with the fresh session
          const fresh = workos.userManagement.loadSealedSession({
            sessionData: refreshResult.sealedSession,
            cookiePassword,
          });
          const freshAuth = await fresh.authenticate();
          if (freshAuth.authenticated) {
            request.userId = freshAuth.user.id;
            request.authMethod = "session";
            return;
          }
        }
      } catch (err: any) {
        app.log.warn({ err }, "Session authentication failed");
        // Fall through to 401
      }
    }

    await reply.status(401).send({
      error: "Missing or invalid authentication. Provide a Bearer API key or a valid session cookie.",
    });
  }

  app.decorate("verifyApiKey", verifyApiKey);
  app.decorate("verifyAuth", verifyAuth);
});
