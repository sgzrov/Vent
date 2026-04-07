import { apiFetch } from "../lib/api.js";
import { buildRunSummaryJson, writeJsonStdout } from "../lib/output.js";
import { printError } from "../lib/output.js";
import { loadAccessToken } from "../lib/config.js";

interface StatusArgs {
  runId: string;
  verbose?: boolean;
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
    const aggregate = data.aggregate as { conversation_calls?: { total?: number; passed?: number; failed?: number } } | undefined;
    const counts = aggregate?.conversation_calls;
    const results = Array.isArray(data.results) ? data.results : [];
    const summary = buildRunSummaryJson({
      runId: typeof data.id === "string" ? data.id : args.runId,
      status: data.status,
      total: counts?.total,
      passed: counts?.passed,
      failed: counts?.failed,
      rawCalls: results,
      verbose: args.verbose,
      runDetails: {
        created_at: data.created_at,
        started_at: data.started_at,
        finished_at: data.finished_at,
        duration_ms: data.duration_ms,
        error_text: data.error_text,
        aggregate: data.aggregate,
      },
    });

    writeJsonStdout(summary);

    const status = data.status as string;
    return status === "pass" ? 0 : status === "fail" ? 1 : 0;
  } catch (err) {
    printError((err as Error).message);
    return 2;
  }
}
