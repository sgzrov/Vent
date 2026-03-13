import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SETUP_GUIDE,
  VENT_DOCS,
} from "../docs.js";

export function registerDocTools(server: McpServer) {
  server.registerTool("vent_setup_workspace", {
    title: "Setup Guide",
    description: "Get setup instructions for connecting Vent to Claude Code, Cursor, Windsurf, and team sharing via .mcp.json. Call this when a user asks how to install or configure Vent.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: SETUP_GUIDE }],
  }));

  server.registerTool("vent_docs", {
    title: "Reference Guide",
    description: "Complete reference for config schemas (connection, conversation_tests, load_test), test authoring guide, metrics definitions, result format, and integration specifics. Call this when you need config format details, metric definitions, or help writing tests.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: VENT_DOCS }],
  }));
}
