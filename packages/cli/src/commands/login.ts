import { saveAccessToken, validateAccessTokenFormat, loadAccessToken } from "../lib/config.js";
import { deviceAuthFlow } from "../lib/auth.js";
import { printError, printInfo, printSuccess } from "../lib/output.js";

interface LoginArgs {
  accessToken?: string;
  status?: boolean;
}

export async function loginCommand(args: LoginArgs): Promise<number> {
  // Check login status
  if (args.status) {
    const token = await loadAccessToken();
    if (token) {
      printSuccess(`Logged in (${token.slice(0, 12)}...)`, { force: true });
      return 0;
    }
    printInfo("Not logged in. Run `npx vent-hq login`.", { force: true });
    return 1;
  }

  // Direct token save (CI / non-interactive)
  if (args.accessToken) {
    if (!validateAccessTokenFormat(args.accessToken)) {
      printError("Invalid Vent access token. Tokens start with 'vent_'.");
      return 2;
    }
    await saveAccessToken(args.accessToken);
    printSuccess("Vent access token saved to ~/.vent/credentials", { force: true });
    return 0;
  }

  const result = await deviceAuthFlow();
  if (result.ok) {
    printSuccess("Logged in! Vent access token saved to ~/.vent/credentials", { force: true });
    return 0;
  }
  return 1;
}
