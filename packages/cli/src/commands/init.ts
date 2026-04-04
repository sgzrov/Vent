import { loadAccessToken, saveAccessToken, API_BASE } from "../lib/config.js";
import { detectGitHubToken } from "../lib/github.js";
import { printError, printSuccess } from "../lib/output.js";
import { installSkillsAndScaffold } from "../lib/setup.js";

export async function initCommand(): Promise<number> {
  const cwd = process.cwd();

  // 1. Check/save access token
  const token = await loadAccessToken();

  if (token) {
    printSuccess("Authenticated.", { force: true });
  } else {
    // No token — try GitHub identity first, then anonymous bootstrap
    let authenticated = false;
    const ghToken = detectGitHubToken();

    if (ghToken) {
      try {
        const res = await fetch(`${API_BASE}/auth/github`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ github_token: ghToken }),
        });

        if (res.ok) {
          const { access_token, username } = (await res.json()) as {
            access_token?: string;
            username: string;
          };
          if (!access_token) throw new Error("Missing access token");
          const token = access_token;
          await saveAccessToken(token);
          printSuccess(`Authenticated as @${username} (via GitHub).`, {
            force: true,
          });
          authenticated = true;
        }
      } catch {
        // GitHub verification failed — fall through to bootstrap
      }
    }

    if (!authenticated) {
      // Anonymous bootstrap (zero interaction, limited runs)
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

      const { access_token, run_limit } = (await res.json()) as {
        access_token?: string;
        run_limit: number;
      };
      if (!access_token) {
        printError("Bootstrap did not return a Vent access token.");
        return 1;
      }
      const token = access_token;
      await saveAccessToken(token);
      printSuccess(
        `Account created (${run_limit} runs). You'll be prompted to sign in for unlimited access.`,
        { force: true },
      );
    }
  }

  // 2. Detect editors, install skills, scaffold suite
  await installSkillsAndScaffold(cwd);

  printSuccess(
    "Ready — your coding agent can now run calls with `npx vent-hq run`.",
    { force: true },
  );
  return 0;
}
