/**
 * Loads prompt content from plain text files in the resources folder.
 *
 * Folder structure:
 *   resources/system/       — MCP server-level instructions
 *   resources/tool_prompts/ — Tool descriptions and tool response content
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// At runtime: __dirname = apps/api/dist/routes/mcp
// Resources:              apps/api/src/routes/mcp/resources
const RESOURCES_DIR = resolve(__dirname, "../../../src/routes/mcp/resources");

function load(...segments: string[]): string {
  return readFileSync(resolve(RESOURCES_DIR, ...segments), "utf-8");
}

// System
export const SYSTEM_INSTRUCTIONS = load("system", "instructions.txt");

// Tool response content (returned by vent_setup_workspace / vent_docs)
export const SETUP_GUIDE = load("tool_prompts", "setup-workspace.txt");
export const VENT_DOCS = load("tool_prompts", "docs.txt");

// Tool descriptions (used as MCP tool description fields)
export const RUN_TESTS_DESCRIPTION = load("tool_prompts", "run-tests.txt");
export const GET_RUN_STATUS_DESCRIPTION = load("tool_prompts", "get-run-status.txt");

