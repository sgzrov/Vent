import { loadAccessToken } from "../lib/config.js";
import { deviceAuthFlow } from "../lib/auth.js";
import { printInfo, printSuccess } from "../lib/output.js";

interface LoginArgs {
  status?: boolean;
}

export async function loginCommand(args: LoginArgs): Promise<number> {
  if (args.status) {
    const token = await loadAccessToken();
    if (token) {
      printSuccess(`Logged in (${token.slice(0, 12)}...)`, { force: true });
      return 0;
    }
    printInfo("Not logged in. Run `npx vent-hq login`.", { force: true });
    return 1;
  }

  const result = await deviceAuthFlow();
  if (result.ok) {
    printSuccess("Logged in! Vent access token saved to ~/.vent/credentials", { force: true });
    return 0;
  }
  return 1;
}
