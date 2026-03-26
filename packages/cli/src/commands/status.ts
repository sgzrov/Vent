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
    printError("No API key found. Set VENT_API_KEY, run `npx vent-hq login`, or pass --api-key.");
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
      const results = data.results as unknown[] | undefined;
      const testCount = results?.length ?? 0;

      if (status === "running" || status === "queued") {
        printInfo(`Run ${args.runId}: ${status} (${testCount} tests completed so far)`);
      } else {
        // Completed run — show rich output
        const isTTY = process.stdout.isTTY;
        const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
        const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
        const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);
        const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);

        if (status === "pass") {
          process.stdout.write(green(bold("Run passed")) + "\n");
        } else {
          process.stdout.write(red(bold("Run failed")) + "\n");
        }

        let passed = 0;
        let failed = 0;

        if (results && Array.isArray(results)) {
          for (const raw of results) {
            const formatted = formatConversationResult(raw);
            if (formatted) {
              const isPass = formatted.status === "completed";
              if (isPass) passed++;
              else failed++;

              const s = isPass ? green("✔") : red("✘");
              const name = formatted.name ?? "test";
              const dur = (formatted.duration_ms / 1000).toFixed(1) + "s";
              const parts = [s, bold(name), dim(dur)];

              if (formatted.latency?.p50_ttfw_ms != null) {
                parts.push(`p50: ${formatted.latency.p50_ttfw_ms}ms`);
              }

              process.stdout.write("  " + parts.join("  ") + "\n");
            }
          }
        }

        // Summary line
        const total = passed + failed;
        if (total > 0) {
          const parts: string[] = [];
          if (passed) parts.push(green(`${passed} passed`));
          if (failed) parts.push(red(`${failed} failed`));
          parts.push(`${total} total`);
          process.stdout.write(parts.join(dim(" · ")) + "\n");
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
        const meta = (event.metadata_json ?? {}) as Record<string, unknown>;
        const status = meta.status as string | undefined;
        exitCode = status === "pass" ? 0 : 1;
      }
    }
  } catch (err) {
    printError(`Stream error: ${(err as Error).message}`);
    return 2;
  }
  return exitCode;
}
