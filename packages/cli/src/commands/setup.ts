import * as fs from "node:fs/promises";
import * as path from "node:path";
import { statSync } from "node:fs";
import { printSuccess, printInfo, printWarn } from "../lib/output.js";

// @ts-ignore — embedded at build time via esbuild text loader
import claudeCodeSkill from "../skills/claude-code.md";
// @ts-ignore
import cursorSkill from "../skills/cursor.md";
// @ts-ignore
import windsurfSkill from "../skills/windsurf.md";

interface Editor {
  name: string;
  detect: () => boolean;
  install: (cwd: string) => Promise<void>;
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const editors: Editor[] = [
  {
    name: "Claude Code",
    detect: () => {
      // Claude Code is always available if user runs it
      return true;
    },
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
  {
    name: "Windsurf",
    detect: () => dirExists(path.join(process.cwd(), ".windsurf")),
    install: async (cwd: string) => {
      const agentsPath = path.join(cwd, "AGENTS.md");
      let existing = "";
      try {
        existing = await fs.readFile(agentsPath, "utf-8");
      } catch {
        // No existing file
      }

      if (existing.includes("# Vent")) {
        printWarn("Windsurf: AGENTS.md already has Vent section, skipping.");
        return;
      }

      const separator = existing ? "\n\n" : "";
      await fs.writeFile(agentsPath, existing + separator + windsurfSkill);
      printSuccess("Windsurf: AGENTS.md updated");
    },
  },
];

export async function setupCommand(): Promise<number> {
  const cwd = process.cwd();
  printInfo("Detecting editors…");

  let installed = 0;
  for (const editor of editors) {
    if (editor.detect()) {
      await editor.install(cwd);
      installed++;
    }
  }

  if (installed === 0) {
    printWarn("No supported editors detected. Run from your project directory.");
    return 1;
  }

  printSuccess(`Set up ${installed} editor(s). Agents will discover Vent via skill files.`);
  return 0;
}
