import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = path.join(homedir(), ".vent");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials");

export const API_BASE = process.env.VENT_API_URL ?? "https://vent-api.fly.dev";

export async function loadApiKey(): Promise<string | null> {
  // 1. Environment variable (highest priority)
  if (process.env.VENT_API_KEY) return process.env.VENT_API_KEY;

  // 2. Credentials file
  try {
    const raw = await fs.readFile(CREDENTIALS_FILE, "utf-8");
    const key = raw.trim();
    if (key) return key;
  } catch {
    // File doesn't exist
  }

  return null;
}

export async function saveApiKey(key: string): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CREDENTIALS_FILE, key + "\n", { mode: 0o600 });
}

export function validateApiKeyFormat(key: string): boolean {
  return key.startsWith("vent_") && key.length > 10;
}
