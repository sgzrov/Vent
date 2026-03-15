import { apiFetch } from "../lib/api.js";
import { streamRunEvents } from "../lib/sse.js";
import { printEvent, printError, printInfo } from "../lib/output.js";
import { loadApiKey } from "../lib/config.js";
import { formatConversationResult, formatLoadTestResult } from "@vent/shared";

interface StatusArgs {
  runId: string;
  apiKey?: string;
  json: boolean;
  stream: boolean;
}

export async function statusCommand(args: StatusArgs): Promise<number> {
  const apiKey = args.apiKey ?? (await loadApiKey());
  if (!apiKey) {
    printError("No API key found. Set VENT_API_KEY, run `vent login`, or pass --api-key.");
    return 2;
  }

  if (args.stream) {
    return streamStatus(args.runId, apiKey, args.json);
  }

  try {
    const res = await apiFetch(`/runs/${args.runId}`, apiKey);
    const data = (await res.json()) as Record<string, unknown>;

    if (args.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    } else {
      const status = data.status as string;
      const testCount = (data.results as unknown[] | undefined)?.length ?? 0;
      printInfo(`Run ${args.runId}: ${status} (${testCount} tests)`);

      if (data.results && Array.isArray(data.results)) {
        for (const raw of data.results) {
          const formatted = formatConversationResult(raw);
          if (formatted) {
            const s = formatted.status === "completed" ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
            const name = formatted.name ?? "test";
            const dur = (formatted.duration_ms / 1000).toFixed(1) + "s";
            process.stdout.write(`  ${s} ${name}  ${dur}\n`);
          }
        }
      }
    }

    const status = data.status as string;
    return status === "pass" ? 0 : status === "fail" ? 1 : 0;
  } catch (err) {
    printError((err as Error).message);
    return 2;
  }
}

async function streamStatus(runId: string, apiKey: string, json: boolean): Promise<number> {
  let exitCode = 0;
  try {
    for await (const event of streamRunEvents(runId, apiKey)) {
      printEvent(event, json);
      if (event.event_type === "run_complete") {
        const status = (event.data as { status?: string }).status;
        exitCode = status === "pass" ? 0 : 1;
      }
    }
  } catch (err) {
    printError(`Stream error: ${(err as Error).message}`);
    return 2;
  }
  return exitCode;
}
