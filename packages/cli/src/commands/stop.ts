import { loadApiKey } from "../lib/config.js";
import { apiFetch, ApiError } from "../lib/api.js";
import { printError, printSuccess } from "../lib/output.js";

interface StopArgs {
  runId: string;
  apiKey?: string;
}

export async function stopCommand(args: StopArgs): Promise<number> {
  const key = args.apiKey ?? (await loadApiKey());
  if (!key) {
    printError("Not authenticated. Run `npx vent-hq init` first.");
    return 2;
  }

  try {
    const res = await apiFetch(`/runs/${args.runId}/stop`, key, {
      method: "POST",
    });
    const data = (await res.json()) as { id: string; status: string };
    printSuccess(`Run ${data.id} cancelled.`, { force: true });
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string };
      printError(body?.error ?? `Failed to stop run (${err.status}).`);
      return 1;
    }
    throw err;
  }

  process.exit(0);
}
