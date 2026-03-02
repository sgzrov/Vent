/**
 * Loads guide/prompt content from plain text files in the resources folder.
 * Prompts are stored as .txt files for clean separation from code.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// At runtime: __dirname = apps/api/dist/routes/mcp
// Resources:              apps/api/src/routes/mcp/resources
const RESOURCES_DIR = resolve(__dirname, "../../../src/routes/mcp/resources");

function load(name: string): string {
  return readFileSync(resolve(RESOURCES_DIR, name), "utf-8");
}

export const SETUP_GUIDE = load("setup-guide.txt");
export const SCENARIO_GUIDE = load("scenario-guide.txt");
export const RESULT_GUIDE = load("result-guide.txt");
export const AUDIO_TEST_REFERENCE = load("audio-test-reference.txt");
export const EVAL_EXAMPLES = load("eval-examples.txt");
