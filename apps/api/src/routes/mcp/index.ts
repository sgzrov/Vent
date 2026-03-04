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
        "Test configuration lives in `voiceci-config.json` at the project root — a single file with connection config, infrastructure probes, conversation tests, and red-team attacks.",
        "",
        "### Phase 1: Setup",
        "Check if `voiceci-config.json` exists in the project root.",
        "  - If YES → read it and proceed to Phase 2.",
        "  - If NO → call voiceci_guide_test_authoring, read agent code, design tests, and create `voiceci-config.json`.",
        "",
        "### Phase 2: Run Tests",
        "Read `voiceci-config.json` and call voiceci_run_tests with its contents as the `config` parameter.",
        "  - For remote/deployed agents: the run queues immediately.",
        "  - For local WebSocket agents: execute the returned relay command FIRST to connect your agent.",
        "",
        "### Phase 3: Monitor with Subagents",
        "After voiceci_run_tests returns a run_id, use subagents for parallel monitoring:",
        "",
        "**Infrastructure probes** — spawn one subagent per probe (3 total, in parallel):",
        '  - Subagent 1: "Call voiceci_get_run_status with run_id={run_id}, test_type=infrastructure, test_name=audio_quality. Return the results."',
        '  - Subagent 2: "Call voiceci_get_run_status with run_id={run_id}, test_type=infrastructure, test_name=latency. Return the results."',
        '  - Subagent 3: "Call voiceci_get_run_status with run_id={run_id}, test_type=infrastructure, test_name=echo. Return the results."',
        "",
        "**Conversation tests** — after infrastructure subagents return, spawn one subagent per conversation test (in parallel):",
        '  - For each test name in the config: "Call voiceci_get_run_status with run_id={run_id}, test_type=conversation, test_name={test_name}. Return the results."',
        "",
        "Each subagent calls voiceci_get_run_status with its filter, gets the result when ready, and returns it. The user sees per-test progress as each subagent completes.",
        "",
        "### Phase 4: Results Summary",
        "After all subagents return, call voiceci_get_run_status once without filters to get the full results summary. Report pass/fail to the user.",
        "",
        "## Important rules",
        "- NEVER modify the user's agent source code, dependencies, or environment files. VoiceCI is a testing tool — it observes the agent, it does not change it. If tests fail due to auth errors, missing env vars, or crashes, report the error to the user.",
        "- VoiceCI automatically provides API keys (DEEPGRAM_API_KEY, ANTHROPIC_API_KEY) to the agent process via the relay tunnel. The user does NOT need their own keys for these services.",
        "- For local WebSocket agents without agent_url, VoiceCI uses a relay tunnel. Execute the returned command to start your agent and connect it to VoiceCI. Code changes take effect immediately without re-uploading.",
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
