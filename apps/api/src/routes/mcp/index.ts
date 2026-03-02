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
        "  - If NO → call voiceci_get_scenario_guide, read agent code, design tests, and create the `voiceci/` folder with `audio.json` (default). Add `conversations.json` if the user also wants conversation tests.",
        "",
        "Step 2: Read all JSON files in `voiceci/`, merge them into one config object, then call voiceci_run_suite with the merged object as the `config` parameter.",
        "  - Merging: spread/Object.assign all files together. `audio.json` provides adapter config + audio_tests, `conversations.json` provides conversation_tests.",
        "  - To run only audio tests: only read `audio.json`.",
        "  - To run only conversation tests: only read `conversations.json` (it must include adapter config if `audio.json` doesn't exist).",
        "  - For remote/deployed agents: the run queues immediately — done.",
        "  - For bundled agents: run the returned upload_command in the project root.",
        "",
        "Step 3: voiceci_get_status → poll with run_id until status is 'pass' or 'fail'.",
        "",
        "On failure: update the failing tests in the relevant file (`audio.json` or `conversations.json`), then re-run from Step 2.",
        "",
        "## Important rules",
        "- ALWAYS read the `voiceci/` folder, merge the JSON files, and pass the merged config to voiceci_run_suite.",
        "- Default to creating `audio.json` first. Only create `conversations.json` when the user asks for conversation tests.",
        "- VoiceCI runs tests REMOTELY in cloud infrastructure — it CANNOT reach localhost. Do NOT start the agent locally. For bundled agents (websocket with start_command), VoiceCI uploads your code and runs it in its own infrastructure. You MUST execute the returned upload command.",
        "- Only call voiceci_get_scenario_guide for first-time setup. Do NOT call multiple guide tools at once.",
        "- voiceci_get_result_guide is an optional deep-dive — only call it when you need detailed result interpretation help.",
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
