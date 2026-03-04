/**
 * Loads guide/prompt content from plain text files in the resources folder.
 * Prompts are stored as .txt files for clean separation from code.
 *
 * Folder structure:
 *   resources/system/  — MCP server-level instructions
 *   resources/guides/  — Documentation returned by voiceci_guide_* tools
 *   resources/tools/   — Action tool descriptions
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

// Guides (returned by voiceci_guide_* doc tools)
export const SETUP_GUIDE = load("guides", "setup.txt");
export const SCENARIO_GUIDE = load("guides", "scenario.txt");
export const RESULT_GUIDE = load("guides", "results.txt");
export const AUDIO_TEST_REFERENCE = load("guides", "audio-tests.txt");
export const EVAL_EXAMPLES = load("guides", "security-and-tools.txt");

// Tool descriptions (used as MCP tool description fields)
export const RUN_TESTS_DESCRIPTION = load("tools", "run-tests.txt");
export const RUN_LOAD_TEST_DESCRIPTION = load("tools", "run-load-test.txt");
export const GET_RUN_STATUS_DESCRIPTION = load("tools", "get-run-status.txt");
