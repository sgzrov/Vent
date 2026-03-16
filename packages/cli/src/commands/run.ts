import * as fs from "node:fs/promises";
import { apiFetch } from "../lib/api.js";
import { streamRunEvents } from "../lib/sse.js";
import { startRelay } from "../lib/relay.js";
import { printEvent, printError, printInfo, printSummary } from "../lib/output.js";
import { loadApiKey } from "../lib/config.js";
import type { RelayHandle } from "../lib/relay.js";
import type { SSEEvent } from "../lib/sse.js";

interface RunArgs {
  config?: string;
  file?: string;
  apiKey?: string;
  json: boolean;
  submit: boolean;
}

export async function runCommand(args: RunArgs): Promise<number> {
  // 1. Resolve API key
  const apiKey = args.apiKey ?? (await loadApiKey());
  if (!apiKey) {
    printError("No API key found. Set VENT_API_KEY, run `vent login`, or pass --api-key.");
    return 2;
  }

  // 2. Parse config
  let config: unknown;
  try {
    if (args.file) {
      const raw = await fs.readFile(args.file, "utf-8");
      config = JSON.parse(raw);
    } else if (args.config) {
      config = JSON.parse(args.config);
    } else {
      printError("Provide --config '{...}' or -f <file>.");
      return 2;
    }
  } catch (err) {
    printError(`Invalid config JSON: ${(err as Error).message}`);
    return 2;
  }

  // 3. Submit run
  printInfo("Submitting run…");
  let submitResult: {
    run_id: string;
    status: string;
    relay_config?: {
      run_id: string;
      relay_token: string;
      api_url: string;
      agent_port: number;
      start_command: string | null;
      health_endpoint: string;
    };
  };

  try {
    const res = await apiFetch("/runs/submit", apiKey, {
      method: "POST",
      body: JSON.stringify({ config }),
    });
    submitResult = (await res.json()) as typeof submitResult;
  } catch (err) {
    printError(`Submit failed: ${(err as Error).message}`);
    return 2;
  }

  const { run_id } = submitResult;
  printInfo(`Run ${run_id} created.`);

  // 4. Handle --submit (fire-and-forget)
  if (args.submit) {
    if (submitResult.relay_config) {
      printError(
        "Cannot use --submit with local agents (start_command). " +
        "The CLI must stay running to manage the relay. " +
        "Use agent_url for deployed agents, or run without --submit."
      );
      return 2;
    }
    process.stdout.write(
      JSON.stringify({
        run_id,
        status: submitResult.status,
        check: `vent status ${run_id} --json`,
      }) + "\n"
    );
    return 0;
  }

  // 5. Start relay if needed (local agent)
  let relay: RelayHandle | null = null;
  if (submitResult.relay_config) {
    printInfo("Starting relay for local agent…");
    try {
      relay = await startRelay(submitResult.relay_config);
      printInfo("Relay connected, agent started.");
    } catch (err) {
      printError(`Relay failed: ${(err as Error).message}`);
      return 2;
    }
  }

  // 6. Stream results
  const abortController = new AbortController();
  let exitCode = 0;
  const testResults: SSEEvent[] = [];
  let runCompleteData: Record<string, unknown> | null = null;

  const onSignal = () => {
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    for await (const event of streamRunEvents(run_id, apiKey, abortController.signal)) {
      printEvent(event, args.json);

      if (event.event_type === "test_completed") {
        testResults.push(event);
      }

      if (event.event_type === "run_complete") {
        runCompleteData = event.data;
        const status = (event.data as { status?: string }).status;
        exitCode = status === "pass" ? 0 : 1;
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      printError(`Stream error: ${(err as Error).message}`);
      exitCode = 2;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (relay) {
      await relay.cleanup();
    }
  }

  // 7. Print summary (useful when agent reads buffered output all at once)
  if (runCompleteData && testResults.length > 0) {
    printSummary(testResults, runCompleteData, run_id, args.json);
  }

  return exitCode;
}
