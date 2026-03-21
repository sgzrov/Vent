import { saveApiKey, validateApiKeyFormat, loadApiKey } from "../lib/config.js";
import { deviceAuthFlow } from "../lib/auth.js";
import { printError, printInfo, printSuccess } from "../lib/output.js";

interface LoginArgs {
  apiKey?: string;
  status?: boolean;
}

export async function loginCommand(args: LoginArgs): Promise<number> {
  // Check login status
  if (args.status) {
    const key = await loadApiKey();
    if (key) {
      printSuccess(`Logged in (${key.slice(0, 12)}...)`, { force: true });
      return 0;
    }
    printInfo("Not logged in. Run `npx vent-hq login`.", { force: true });
    return 1;
  }

  // Direct key save (CI / non-interactive)
  if (args.apiKey) {
    if (!validateApiKeyFormat(args.apiKey)) {
      printError("Invalid API key. Keys start with 'vent_'.");
      return 2;
    }
    await saveApiKey(args.apiKey);
    printSuccess("API key saved to ~/.vent/credentials", { force: true });
    return 0;
  }

  const result = await deviceAuthFlow();
  if (result.ok) {
    printSuccess("Logged in! API key saved to ~/.vent/credentials", { force: true });
    return 0;
  }
  return 1;
}
