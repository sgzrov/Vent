import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SETUP_GUIDE,
  REFERENCE_GUIDE,
} from "../docs.js";

export function registerDocTools(server: McpServer) {
  server.registerTool("vent_setup_workspace", {
    title: "Setup Guide",
    description: "Get setup instructions for connecting VoiceCI to Claude Code, Cursor, Windsurf, and team sharing via .mcp.json. Call this when a user asks how to install or configure VoiceCI.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: SETUP_GUIDE }],
  }));

  server.registerTool("vent_docs", {
    title: "Reference Guide",
    description: "Complete reference for .voiceci/suite.json format, dual config system, field tables, audio actions, red-team categories, metrics definitions, result interpretation, and tool call integration. Call this when you need config format details, metric definitions, or integration specifics.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: REFERENCE_GUIDE }],
  }));
}
