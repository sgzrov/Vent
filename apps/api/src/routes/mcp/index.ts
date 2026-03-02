import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  transports,
  mcpServers,
  cleanupSession,
} from "./session.js";
import { registerDocTools } from "./tools/doc-tools.js";
import { registerActionTools } from "./tools/action-tools.js";

export { transports, mcpServers } from "./session.js";

function createMcpServer(app: FastifyInstance, apiKeyId: string, userId: string): McpServer {
  const mcpServer = new McpServer(
    { name: "voiceci", version: "0.5.0" },
    {
      capabilities: {},
      instructions: [
        "VoiceCI — CI/CD testing for voice AI agents.",
        "",
        "## Workflow",
        "",
        "Test configuration lives in a `voiceci/` folder in the project root, with separate files for each test type:",
        "- `voiceci/audio.json` — agent connection config + audio tests + thresholds (default)",
        "- `voiceci/conversations.json` — conversation test scenarios",
        "",
        "Step 1: Check if the `voiceci/` folder exists in the project root.",
        "  - If YES → read all JSON files inside it and skip to Step 2.",
        "  - If NO → call voiceci_guide_test_authoring, read agent code, design tests, and create the `voiceci/` folder with both `audio.json` and `conversations.json`.",
        "",
        "Step 2: Read `voiceci/audio.json`, then call voiceci_run_tests with its contents as the `config` parameter. By default, only run audio tests.",
        "  - To also run conversation tests: read `voiceci/conversations.json`, merge it into the config (spread/Object.assign), then call voiceci_run_tests with the merged config.",
        "  - To run only conversation tests: read both files, merge them, but remove `audio_tests` from the merged config.",
        "  - For remote/deployed agents: the run queues immediately — done.",
        "  - For local WebSocket agents: run the returned relay command to start your agent and connect to VoiceCI.",
        "",
        "Step 3: voiceci_get_run_status → poll with run_id until status is 'pass' or 'fail'.",
        "",
        "On failure: update the failing tests in the relevant file (`audio.json` or `conversations.json`), then re-run from Step 2.",
        "",
        "## Important rules",
        "- NEVER modify the user's agent source code, dependencies, or environment files. VoiceCI is a testing tool — it observes the agent, it does not change it. If tests fail due to auth errors, missing env vars, or crashes, report the error to the user. Do NOT install packages, edit .env files, add dotenv, or change package.json.",
        "- VoiceCI automatically provides API keys (DEEPGRAM_API_KEY, ANTHROPIC_API_KEY) to the agent process via the relay tunnel. The user does NOT need their own keys for these services.",
        "- ALWAYS read the `voiceci/` folder, merge the JSON files, and pass the merged config to voiceci_run_tests.",
        "- Always create both `audio.json` and `conversations.json` during setup, but only include `audio.json` in the config by default. Include `conversations.json` only when the user explicitly asks to run conversation tests.",
        "- For local WebSocket agents without agent_url, VoiceCI uses a relay tunnel. Execute the returned command to start your agent and connect it to VoiceCI. Your agent runs locally with file watching — code changes take effect immediately without re-uploading. You MUST execute the returned relay command.",
        "- Only call voiceci_guide_test_authoring for first-time setup. Do NOT call multiple guide tools at once.",
        "- voiceci_guide_results is an optional deep-dive — only call it when you need detailed result interpretation help.",
      ].join("\n"),
    },
  );

  registerDocTools(mcpServer);
  registerActionTools(mcpServer, app, apiKeyId, userId);

  return mcpServer;
}

// ============================================================
// Route registration
// ============================================================

export async function mcpRoutes(app: FastifyInstance) {
  const authPreHandler = { preHandler: app.verifyApiKey };

  // POST /mcp — session-aware routing
  app.post("/mcp", authPreHandler, async (request, reply) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;

    // Existing session — route to its transport
    if (sessionId && transports.has(sessionId)) {
      reply.hijack();
      await transports.get(sessionId)!.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    // New session — must be an initialize request
    if (!sessionId && isInitializeRequest(request.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          mcpServers.set(sid, server);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) cleanupSession(sid);
      };

      const server = createMcpServer(app, request.apiKeyId!, request.userId!);
      await server.connect(transport);

      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    // Invalid request
    reply.status(400).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
  });

  // GET /mcp — SSE stream for server-push notifications
  app.get("/mcp", authPreHandler, async (request, reply) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
    }
    reply.hijack();
    await transports.get(sessionId)!.handleRequest(request.raw, reply.raw);
  });

  // DELETE /mcp — session cleanup
  app.delete("/mcp", authPreHandler, async (request, reply) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
    }
    reply.hijack();
    await transports.get(sessionId)!.handleRequest(request.raw, reply.raw);
  });

  // Cleanup all sessions on server shutdown
  app.addHook("onClose", async () => {
    for (const [sid] of transports) {
      cleanupSession(sid);
    }
  });
}
