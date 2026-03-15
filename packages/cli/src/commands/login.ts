import * as readline from "node:readline/promises";
import { saveApiKey, validateApiKeyFormat } from "../lib/config.js";
import { printError, printSuccess } from "../lib/output.js";

interface LoginArgs {
  apiKey?: string;
}

export async function loginCommand(args: LoginArgs): Promise<number> {
  let key = args.apiKey;

  if (!key) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      key = await rl.question("API key: ");
    } finally {
      rl.close();
    }
  }

  if (!key || !validateApiKeyFormat(key)) {
    printError("Invalid API key. Keys start with 'vent_'.");
    return 2;
  }

  await saveApiKey(key);
  printSuccess("API key saved to ~/.vent/credentials");
  return 0;
}
