import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const transports = new Map<string, StreamableHTTPServerTransport>();
export const mcpServers = new Map<string, McpServer>();

export function cleanupSession(sessionId: string) {
  transports.delete(sessionId);
  const server = mcpServers.get(sessionId);
  if (server) {
    server.close().catch(() => {});
    mcpServers.delete(sessionId);
  }
}
