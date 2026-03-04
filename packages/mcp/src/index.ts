import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env["VOICECI_API_KEY"];
if (!API_KEY) {
  process.stderr.write(
    "Error: VOICECI_API_KEY environment variable is required.\n" +
      "Get your key at https://voiceci.dev\n",
  );
  process.exit(1);
}

const REMOTE_URL =
  process.env["VOICECI_URL"] ?? "https://voiceci-api.fly.dev/mcp";
const REQUEST_TIMEOUT = 600_000; // 10 minutes — test runs can be long

async function main() {
  // Connect to the remote VoiceCI MCP server over HTTP
  const upstream = new Client(
    { name: "voiceci-mcp-proxy", version: "0.5.0" },
    { capabilities: {} },
  );

  const httpTransport = new StreamableHTTPClientTransport(
    new URL(REMOTE_URL),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
    },
  );

  await upstream.connect(httpTransport);

  // Create the local stdio server that MCP clients (Claude Code, Cursor) talk to
  const server = new Server(
    { name: "voiceci", version: "0.5.0" },
    { capabilities: { tools: {} } },
  );

  // Forward tools/list → upstream
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return await upstream.listTools();
  });

  // Forward tools/call → upstream
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await upstream.callTool(request.params, undefined, {
      timeout: REQUEST_TIMEOUT,
      resetTimeoutOnProgress: true,
    });
  });

  // Start listening on stdio
  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  // Graceful shutdown
  const shutdown = async () => {
    await server.close();
    await upstream.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
