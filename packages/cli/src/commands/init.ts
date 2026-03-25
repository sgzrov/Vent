import { loadApiKey, saveApiKey, validateApiKeyFormat } from "../lib/config.js";
import { deviceAuthFlow } from "../lib/auth.js";
import { printError, printSuccess } from "../lib/output.js";
import { installSkillsAndScaffold } from "../lib/setup.js";

interface InitArgs {
  apiKey?: string;
}

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
    printSuccess("API key saved to ~/.vent/credentials", { force: true });
  } else if (key) {
    printSuccess("Authenticated.", { force: true });
  } else {
    // No key — run device auth flow (opens browser, polls for approval)
    const result = await deviceAuthFlow();
    if (!result.ok) {
      printError("Authentication failed. Run `npx vent-hq init` to try again.");
      return 1;
    }
    printSuccess("Logged in! API key saved to ~/.vent/credentials", { force: true });
  }

  // 2. Detect editors, install skills, scaffold suite
  await installSkillsAndScaffold(cwd);

  printSuccess("Ready — your coding agent can now make test calls with `npx vent-hq run`.", { force: true });
  return 0;
}
