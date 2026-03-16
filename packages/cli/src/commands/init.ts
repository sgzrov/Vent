import * as fs from "node:fs/promises";
import * as path from "node:path";
import { statSync } from "node:fs";
import * as readline from "node:readline/promises";
import { loadApiKey, saveApiKey, validateApiKeyFormat } from "../lib/config.js";
import { printError, printInfo, printSuccess, printWarn } from "../lib/output.js";

// @ts-ignore — embedded at build time via esbuild text loader
import claudeCodeSkill from "../skills/claude-code.md";
// @ts-ignore
import cursorSkill from "../skills/cursor.md";

interface InitArgs {
  apiKey?: string;
}

const SUITE_SCAFFOLD = JSON.stringify(
  {
    connection: {
      adapter: "websocket",
      start_command: "TODO: command to start your agent (e.g. npm run start)",
      agent_port: 3001,
    },
    conversation_tests: [
      {
        name: "happy-path",
        caller_prompt:
          "TODO: describe a realistic caller persona and goal based on your agent's domain",
        max_turns: 8,
      },
    ],
  },
  null,
  2,
);

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const editors = [
  {
    name: "Claude Code",
    detect: () => true,
    install: async (cwd: string) => {
      const dir = path.join(cwd, ".claude", "skills", "vent");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), claudeCodeSkill);
      printSuccess("Claude Code: .claude/skills/vent/SKILL.md");
    },
  },
  {
    name: "Cursor",
    detect: () => dirExists(path.join(process.cwd(), ".cursor")),
    install: async (cwd: string) => {
      const dir = path.join(cwd, ".cursor", "rules");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "vent.mdc"), cursorSkill);
      printSuccess("Cursor: .cursor/rules/vent.mdc");
    },
  },
];

export async function initCommand(args: InitArgs): Promise<number> {
  const cwd = process.cwd();

  // 1. Check/save API key
  let key = args.apiKey ?? (await loadApiKey());

  if (!key) {
    if (!process.stdin.isTTY) {
      printError("No API key found. Pass --api-key or set VENT_API_KEY.");
      return 2;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      key = await rl.question("API key: ");
    } finally {
      rl.close();
    }

    if (!key || !validateApiKeyFormat(key)) {
      printError("Invalid API key. Keys start with 'vent_'.");
      return 2;
    }

    await saveApiKey(key);
    printSuccess("API key saved to ~/.vent/credentials");
  } else {
    printInfo("API key found.");
  }

  // 2. Install skill files
  printInfo("Detecting editors…");
  let installed = 0;
  for (const editor of editors) {
    if (editor.detect()) {
      await editor.install(cwd);
      installed++;
    }
  }
  if (installed === 0) {
    printWarn("No supported editors detected.");
  }

  // 3. Scaffold .vent/suite.json if missing
  const suitePath = path.join(cwd, ".vent", "suite.json");
  let suiteExists = false;
  try {
    await fs.access(suitePath);
    suiteExists = true;
  } catch {
    // doesn't exist
  }

  if (!suiteExists) {
    await fs.mkdir(path.dirname(suitePath), { recursive: true });
    await fs.writeFile(suitePath, SUITE_SCAFFOLD + "\n");
    printSuccess(".vent/suite.json created — edit connection and tests for your agent");
  } else {
    printInfo(".vent/suite.json already exists, skipping.");
  }

  printSuccess("Vent initialized. Run `vent run -f .vent/suite.json` to test.");
  return 0;
}
