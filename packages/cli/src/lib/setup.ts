import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { multiselect, isCancel } from "@clack/prompts";
import { printInfo, printSuccess } from "./output.js";

// @ts-ignore — embedded at build time via esbuild text loader
import claudeCodeSkill from "../skills/claude-code.md";
// @ts-ignore
import cursorSkill from "../skills/cursor.md";
// @ts-ignore
import codexSkill from "../skills/codex.md";

export const SUITE_SCAFFOLD = JSON.stringify(
  {
    connection: {
      adapter: "websocket",
      start_command: "TODO: command to start your agent (e.g. npm run start)",
      agent_port: 3001,
    },
    calls: {
      "happy-path": {
        caller_prompt:
          "TODO: describe a realistic caller persona and goal based on your agent's domain",
        max_turns: 8,
      },
    },
  },
  null,
  2,
);

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
  // Claude Code sets CLAUDECODE=1
  if (process.env.CLAUDECODE) return "claude-code";

  // macOS bundle identifier (very reliable)
  const bundleId = process.env.__CFBundleIdentifier ?? "";
  if (bundleId.includes("cursor")) return "cursor";
  if (bundleId.includes("Windsurf") || bundleId.includes("windsurf")) return "cursor"; // same skill format
  if (bundleId.includes("codex")) return "codex";

  // VS Code fork detection via askpass path (cross-platform)
  const askpass = process.env.VSCODE_GIT_ASKPASS_NODE ?? process.env.GIT_ASKPASS ?? "";
  if (/cursor/i.test(askpass)) return "cursor";
  if (/windsurf/i.test(askpass)) return "cursor";
  if (/codex/i.test(askpass)) return "codex";

  // Cursor-specific env var
  if (process.env.CURSOR_CLI) return "cursor";

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
      printSuccess("Claude Code: .claude/skills/vent/SKILL.md", { force: true });
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
      printSuccess("Cursor: .cursor/rules/vent.mdc", { force: true });
    },
  },
  {
    id: "codex",
    name: "Codex",
    detect: () => existsSync(path.join(home, ".codex")) || findBinary("codex"),
    install: async (cwd: string) => {
      await fs.writeFile(path.join(cwd, "AGENTS.md"), codexSkill);
      printSuccess("Codex: AGENTS.md", { force: true });
    },
  },
];

/**
 * Detect editors and install skill files, then scaffold .vent/suite.json if missing.
 * Used by both `init` and `agent-setup` commands.
 */
export async function installSkillsAndScaffold(cwd: string): Promise<void> {
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
      printInfo("Cancelled.", { force: true });
      return;
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

  // Scaffold .vent/suite.json if missing
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
}
