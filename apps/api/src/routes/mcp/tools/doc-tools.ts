import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SETUP_GUIDE,
  SCENARIO_GUIDE,
  RESULT_GUIDE,
} from "../docs.js";

export function registerDocTools(server: McpServer) {
  server.registerTool("voiceci_get_setup_guide", {
    title: "Setup Guide",
    description: "Get setup instructions for connecting VoiceCI to Claude Code, Cursor, Windsurf, and team sharing via .mcp.json. Call this when a user asks how to install or configure VoiceCI.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: SETUP_GUIDE }],
  }));

  server.registerTool("voiceci_get_scenario_guide", {
    title: "Scenario Design Guide",
    description: "PRIMARY GUIDE — call this first when setting up tests. Includes voiceci.json file format, audio test quick reference, red-team tips, tool_call_eval examples, agent analysis steps, code-to-scenario mapping, 7 persona archetypes, and conversation test authoring. This single guide has everything you need to create voiceci.json. Do NOT call other guides alongside this one.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: SCENARIO_GUIDE }],
  }));

  server.registerTool("voiceci_get_result_guide", {
    title: "Result Interpretation Guide",
    description: "Call this after tests complete to interpret results. Covers failure diagnosis, behavioral metrics, iterative testing strategy, and regression scenario generation.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: RESULT_GUIDE }],
  }));
}
