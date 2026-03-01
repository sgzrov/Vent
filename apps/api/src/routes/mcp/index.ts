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
        "All test configuration lives in voiceci.json in the project root. This file is the single source of truth — you MUST read it before running tests, and write it before the first run.",
        "",
        "Step 1: Check if voiceci.json exists in the project root.",
        "  - If YES → read it and skip to Step 2.",
        "  - If NO → call voiceci_get_scenario_guide, then read agent code, design tests, and create voiceci.json.",
        "",
        "Step 2: Read voiceci.json, then call voiceci_run_suite with its parsed contents as the `config` parameter.",
        "  - For remote/deployed agents: the run queues immediately — done.",
        "  - For bundled agents: run the returned upload_command in the project root.",
        "",
        "Step 3: voiceci_get_status → poll with run_id until status is 'pass' or 'fail'.",
        "",
        "On failure: update the failing tests in voiceci.json, then re-run from Step 2.",
        "",
        "## Important rules",
        "- ALWAYS read voiceci.json and pass its contents as the `config` parameter to voiceci_run_suite.",
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
