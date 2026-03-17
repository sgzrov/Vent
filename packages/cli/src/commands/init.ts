import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { multiselect, isCancel } from "@clack/prompts";
import { loadApiKey, saveApiKey, validateApiKeyFormat } from "../lib/config.js";
import { deviceAuthFlow } from "../lib/auth.js";
import { printError, printInfo, printSuccess, printWarn } from "../lib/output.js";

// @ts-ignore — embedded at build time via esbuild text loader
import claudeCodeSkill from "../skills/claude-code.md";
// @ts-ignore
import cursorSkill from "../skills/cursor.md";
// @ts-ignore
import codexSkill from "../skills/codex.md";

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

function detectPackageManager(cwd: string): string {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

interface Editor {
  id: string;
  name: string;
  detect: () => boolean;
  install: (cwd: string) => Promise<void>;
}

function findBinary(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function detectActiveEditor(): string | null {
  // Claude Code sets CLAUDECODE=1 (confirmed via docs)
  if (process.env.CLAUDECODE) return "claude-code";
  // No reliable env vars for Cursor or Codex — return null to fall back to detected editors
  return null;
}

const home = homedir();

const allEditors: Editor[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    detect: () => existsSync(path.join(home, ".claude")) || findBinary("claude"),
    install: async (cwd: string) => {
      const dir = path.join(cwd, ".claude", "skills", "vent");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), claudeCodeSkill);
      printSuccess("Claude Code: .claude/skills/vent/SKILL.md");
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    detect: () => existsSync(path.join(home, ".cursor")),
    install: async (cwd: string) => {
      const dir = path.join(cwd, ".cursor", "rules");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "vent.mdc"), cursorSkill);
      printSuccess("Cursor: .cursor/rules/vent.mdc");
    },
  },
  {
    id: "codex",
    name: "Codex",
    detect: () => existsSync(path.join(home, ".codex")) || findBinary("codex"),
    install: async (cwd: string) => {
      await fs.writeFile(path.join(cwd, "AGENTS.md"), codexSkill);
      printSuccess("Codex: AGENTS.md");
    },
  },
];

export async function initCommand(args: InitArgs): Promise<number> {
  const cwd = process.cwd();

  // 1. Check/save API key
  let key = args.apiKey ?? (await loadApiKey());

  if (args.apiKey) {
    if (!validateApiKeyFormat(args.apiKey)) {
      printError("Invalid API key. Keys start with 'vent_'.");
      return 2;
    }
    await saveApiKey(args.apiKey);
    printSuccess("API key saved to ~/.vent/credentials");
  } else if (key) {
    printSuccess("Authenticated.");
  } else {
    // No key — run device auth flow (opens browser, polls for approval)
    const result = await deviceAuthFlow();
    if (!result.ok) {
      printError("Authentication failed. Run `npx vent-hq init` to try again.");
      return 1;
    }
    printSuccess("Logged in! API key saved to ~/.vent/credentials");
  }

  // 2. Detect editors and let user select
  const detectedIds = allEditors.filter((e) => e.detect()).map((e) => e.id);

  let selected: string[];

  if (process.stdin.isTTY) {
    const result = await multiselect({
      message: "Which coding agent do you use?",
      options: allEditors.map((e) => ({
        value: e.id,
        label: e.name,
        hint: detectedIds.includes(e.id) ? undefined : "not detected",
      })),
      initialValues: detectedIds,
    });

    if (isCancel(result)) {
      printInfo("Cancelled.");
      return 0;
    }
    selected = result;
  } else {
    // Non-TTY (coding agent) — detect which editor is currently active
    const activeId = detectActiveEditor();
    if (activeId) {
      selected = [activeId];
    } else {
      selected = detectedIds.length > 0 ? detectedIds : allEditors.map((e) => e.id);
    }
  }

  // Install selected skill files
  for (const id of selected) {
    const editor = allEditors.find((e) => e.id === id);
    if (editor) await editor.install(cwd);
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
  }

  printSuccess("Ready — your coding agent can now make test calls with `npx vent-hq run`.");
  return 0;
}
