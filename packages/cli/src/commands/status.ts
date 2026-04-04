import { apiFetch } from "../lib/api.js";
import { printError } from "../lib/output.js";
import { loadAccessToken } from "../lib/config.js";

interface StatusArgs {
  runId: string;
}

export async function statusCommand(args: StatusArgs): Promise<number> {
  const accessToken = await loadAccessToken();
  if (!accessToken) {
    printError("No Vent access token found. Run `npx vent-hq init` first.");
    return 2;
  }

  try {
    const res = await apiFetch(`/runs/${args.runId}`, accessToken);
    const data = (await res.json()) as Record<string, unknown>;

    process.stdout.write(JSON.stringify(data, null, 2) + "\n");

    const status = data.status as string;
    return status === "pass" ? 0 : status === "fail" ? 1 : 0;
  } catch (err) {
    printError((err as Error).message);
    return 2;
  }
}
