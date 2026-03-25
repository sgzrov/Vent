import { API_BASE } from "../lib/config.js";
import { saveApiKey, validateApiKeyFormat } from "../lib/config.js";
import { installSkillsAndScaffold } from "../lib/setup.js";
import { printError, printInfo, printSuccess } from "../lib/output.js";

interface AgentSetupArgs {
  email?: string;
  code?: string;
  apiKey?: string;
}

export async function agentSetupCommand(args: AgentSetupArgs): Promise<number> {
  const cwd = process.cwd();

  // Fast path: direct API key
  if (args.apiKey) {
    if (!validateApiKeyFormat(args.apiKey)) {
      printError("Invalid API key. Keys start with 'vent_'.");
      return 2;
    }
    await saveApiKey(args.apiKey);
    printSuccess("API key saved.", { force: true });
    await installSkillsAndScaffold(cwd);
    printSuccess("Ready — your coding agent can now run tests with `npx vent-hq run`.", { force: true });
    return 0;
  }

  if (!args.email) {
    printError("--email is required. Usage: npx vent-hq agent-setup --email user@example.com");
    return 2;
  }

  // Step 1: Send OTP (no --code provided)
  if (!args.code) {
    const res = await fetch(`${API_BASE}/auth/magic-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: args.email }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      printError((body.error as string) ?? `Failed to send code (${res.status}).`);
      return 1;
    }

    printInfo(
      `Check your email (${args.email}) for a 6-digit verification code from Vent.`,
      { force: true },
    );
    printInfo(
      `Then run: npx vent-hq agent-setup --email ${args.email} --code <CODE>`,
      { force: true },
    );
    return 0;
  }

  // Step 2: Verify OTP and get API key
  const res = await fetch(`${API_BASE}/auth/magic-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: args.email, code: args.code }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    printError((body.error as string) ?? `Verification failed (${res.status}).`);
    return 1;
  }

  const { api_key } = (await res.json()) as { api_key: string };
  await saveApiKey(api_key);
  printSuccess("Authenticated! API key saved to ~/.vent/credentials", { force: true });

  await installSkillsAndScaffold(cwd);
  printSuccess("Ready — your coding agent can now run tests with `npx vent-hq run`.", { force: true });
  return 0;
}
