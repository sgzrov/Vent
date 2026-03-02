import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SETUP_GUIDE,
  SCENARIO_GUIDE,
  RESULT_GUIDE,
  AUDIO_TEST_REFERENCE,
  EVAL_EXAMPLES,
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
    description: "PRIMARY GUIDE — call this first when setting up tests. Covers voiceci/ folder format, field references, agent analysis methodology, code-to-scenario mapping, 7 persona archetypes, and conversation test authoring. For audio test details call voiceci_get_audio_test_reference. For red-team and tool call patterns call voiceci_get_eval_examples.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: SCENARIO_GUIDE }],
  }));

  server.registerTool("voiceci_get_result_guide", {
    title: "Result Interpretation Guide",
    description: "Call this after tests complete to interpret results. Covers failure diagnosis, audio analysis metrics, behavioral metrics, iterative testing strategy, and regression scenario generation.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: RESULT_GUIDE }],
  }));

  server.registerTool("voiceci_get_audio_test_reference", {
    title: "Audio Test Reference",
    description: "Audio test definitions, durations, and threshold customization. Call this when you need the list of available audio tests or want to override default thresholds.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: AUDIO_TEST_REFERENCE }],
  }));

  server.registerTool("voiceci_get_eval_examples", {
    title: "Red-Team & Tool Call Guide",
    description: "Detailed red-team attack patterns (all 6 categories with caller_prompt and eval examples) and tool call integration guides for platform adapters, custom WebSocket, WebRTC, and pipeline agents.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text" as const, text: EVAL_EXAMPLES }],
  }));
}
