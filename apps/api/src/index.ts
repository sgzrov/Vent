import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { eq, lt, and } from "drizzle-orm";
import { schema } from "@voiceci/db";
import { healthRoutes } from "./routes/health.js";
import { runRoutes } from "./routes/runs.js";
import { callbackRoutes } from "./routes/callback.js";
import { mcpRoutes } from "./routes/mcp/index.js";
import { keyRoutes } from "./routes/keys.js";
import { relayRoutes } from "./routes/relay.js";
import { dbPlugin } from "./plugins/db.js";
import { queuePlugin } from "./plugins/queue.js";
import { authPlugin } from "./plugins/auth.js";
import { drainLoadTests } from "./services/test-runner.js";

const port = parseInt(process.env["API_PORT"] ?? "3000", 10);
const host = process.env["API_HOST"] ?? "0.0.0.0";

async function main() {
  const app = Fastify({
    logger: {
      level: "info",
    },
  });

  await app.register(cors, {
    origin: process.env["DASHBOARD_URL"] ?? true,
    credentials: true,
    exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version"],
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
  await app.register(relayRoutes);
  await app.register(mcpRoutes);

  // Stuck run cleanup
  const CLEANUP_INTERVAL_MS = 60_000;
  const STUCK_RUNNING_MS = 10 * 60_000;   // "running" for >10 min
  const STUCK_QUEUED_MS = 5 * 60_000;     // "queued" + never activated for >5 min
  let cleanupInterval: ReturnType<typeof setInterval>;

  app.addHook("onClose", async () => {
    clearInterval(cleanupInterval);
    await drainLoadTests();
  });

  await app.listen({ port, host });
  console.log(`VoiceCI API listening on ${host}:${port}`);

  cleanupInterval = setInterval(async () => {
    try {
      // 1. Runs stuck in "running" for >10 minutes (server may have restarted)
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

      // 2. Runs stuck in "queued" that were never activated
      const queuedCutoff = new Date(Date.now() - STUCK_QUEUED_MS);
      const stuckQueued = await app.db
        .update(schema.runs)
        .set({
          status: "fail",
          finished_at: new Date(),
          error_text: "Run was never activated — the relay command was not executed. Re-run voiceci_run_tests and execute the returned command.",
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
