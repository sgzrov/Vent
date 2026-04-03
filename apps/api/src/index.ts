import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { eq, lt, and } from "drizzle-orm";
import { schema } from "@vent/db";
import { healthRoutes } from "./routes/health.js";
import { runRoutes } from "./routes/runs.js";
import { callbackRoutes } from "./routes/callback.js";
import { keyRoutes } from "./routes/keys.js";
import { platformConnectionRoutes } from "./routes/platform-connections.js";
import { relayRoutes } from "./routes/relay.js";
import { deviceRoutes } from "./routes/device.js";
import { agentAuthRoutes } from "./routes/agent-auth.js";
import { agentSessionRoutes } from "./routes/agent-sessions.js";
import { recordingRoutes } from "./routes/recordings.js";
import { dbPlugin } from "./plugins/db.js";
import { queuePlugin } from "./plugins/queue.js";
import { authPlugin } from "./plugins/auth.js";
import { shutdownSubscribers } from "./lib/run-subscribers.js";

const port = parseInt(process.env["API_PORT"] ?? "3000", 10);
const host = process.env["API_HOST"] ?? "0.0.0.0";

function parseMsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function main() {
  const app = Fastify({
    logger: {
      level: "info",
    },
    bodyLimit: 10 * 1024 * 1024, // 10MB — call results with full transcripts can be large
    // Signed recording tokens are longer than the router's default param limit.
    routerOptions: {
      maxParamLength: 512,
    },
  });

  const dashboardUrl = process.env["DASHBOARD_URL"];
  const additionalDashboardUrls = (process.env["DASHBOARD_URLS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const devLocalOrigins =
    process.env["NODE_ENV"] === "production"
      ? []
      : ["http://localhost:3000", "http://127.0.0.1:3000"];
  const allowedOrigins = new Set<string>([
    ...(dashboardUrl ? [dashboardUrl] : []),
    ...additionalDashboardUrls,
    ...devLocalOrigins,
  ]);

  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser/system callers often omit Origin.
      if (!origin) {
        cb(null, true);
        return;
      }
      cb(null, allowedOrigins.has(origin));
    },
    credentials: true,
  });
  await app.register(cookie);
  await app.register(websocket);
  await app.register(dbPlugin);
  await app.register(queuePlugin);
  await app.register(authPlugin);
  await app.register(healthRoutes);
  await app.register(runRoutes);
  await app.register(callbackRoutes);
  await app.register(keyRoutes);
  await app.register(platformConnectionRoutes);
  await app.register(relayRoutes);
  await app.register(deviceRoutes);
  await app.register(agentAuthRoutes);
  await app.register(agentSessionRoutes);
  await app.register(recordingRoutes);

  // Stuck run cleanup
  const cleanupEnabled = (process.env["RUN_CLEANUP_ENABLED"] ?? "true") !== "false";
  const CLEANUP_INTERVAL_MS = parseMsEnv("RUN_CLEANUP_INTERVAL_MS", 60_000);
  const STUCK_RUNNING_MS = parseMsEnv("RUN_STUCK_RUNNING_MS", 60 * 60_000);
  const STUCK_QUEUED_REMOTE_MS = parseMsEnv("RUN_STUCK_QUEUED_REMOTE_MS", 10 * 60_000);
  let cleanupInterval: ReturnType<typeof setInterval> | undefined;

  app.addHook("onClose", async () => {
    if (cleanupInterval) clearInterval(cleanupInterval);
    await shutdownSubscribers();
  });

  await app.listen({ port, host });
  console.log(`Vent API listening on ${host}:${port}`);

  if (!cleanupEnabled) {
    console.log("Run cleanup disabled via RUN_CLEANUP_ENABLED=false");
    return;
  }

  cleanupInterval = setInterval(async () => {
    try {
      // 1. Runs stuck in "running" for too long (likely worker crash/restart)
      const runningCutoff = new Date(Date.now() - STUCK_RUNNING_MS);
      const stuckRunning = await app.db
        .update(schema.runs)
        .set({
          status: "fail",
          finished_at: new Date(),
          error_text: "Run timed out (server may have restarted)",
        })
        .where(
          and(
            eq(schema.runs.status, "running"),
            lt(schema.runs.started_at, runningCutoff),
          )
        )
        .returning({ id: schema.runs.id });

      if (stuckRunning.length > 0) {
        console.log(`Cleaned up ${stuckRunning.length} stuck running run(s): ${stuckRunning.map((r) => r.id).join(", ")}`);
      }

      // 2. Runs stuck in "queued" (worker never picked them up)
      const queuedCutoff = new Date(Date.now() - STUCK_QUEUED_REMOTE_MS);
      const stuckQueued = await app.db
        .update(schema.runs)
        .set({
          status: "fail",
          finished_at: new Date(),
          error_text: "Run timed out in queue — worker did not pick it up. Try again or check worker health.",
        })
        .where(
          and(
            eq(schema.runs.status, "queued"),
            lt(schema.runs.created_at, queuedCutoff),
          )
        )
        .returning({ id: schema.runs.id });

      if (stuckQueued.length > 0) {
        console.log(`Cleaned up ${stuckQueued.length} stuck queued run(s): ${stuckQueued.map((r) => r.id).join(", ")}`);
      }
    } catch (err) {
      console.error("Stuck run cleanup failed:", err);
    }
  }, CLEANUP_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Failed to start API:", err);
  process.exit(1);
});
