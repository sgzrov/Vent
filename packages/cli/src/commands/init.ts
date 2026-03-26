import { loadApiKey, saveApiKey, validateApiKeyFormat, API_BASE } from "../lib/config.js";
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
    // No key — anonymous bootstrap (zero interaction)
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/auth/bootstrap`, { method: "POST" });
    } catch (err) {
      printError(`Failed to reach API: ${(err as Error).message}`);
      return 1;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      printError((body as any).error ?? `Bootstrap failed (${res.status}).`);
      return 1;
    }

    const { api_key, run_limit } = (await res.json()) as {
      api_key: string;
      run_limit: number;
    };
    await saveApiKey(api_key);
    printSuccess(
      `Account created (${run_limit} free runs). Run \`npx vent-hq login\` for unlimited.`,
      { force: true },
    );
  }

  // 2. Detect editors, install skills, scaffold suite
  await installSkillsAndScaffold(cwd);

  printSuccess(
    "Ready — your coding agent can now run tests with `npx vent-hq run`.",
    { force: true },
  );
  return 0;
}
