import * as fs from "node:fs/promises";
import * as net from "node:net";
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
  test?: string;
  apiKey?: string;
  json: boolean;
  submit: boolean;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  process.stderr.write(`[vent ${ts}] ${msg}\n`);
}

export async function runCommand(args: RunArgs): Promise<number> {
  log(`start args=${JSON.stringify({ file: args.file, test: args.test, json: args.json, submit: args.submit })}`);

  // 1. Resolve API key
  const apiKey = args.apiKey ?? (await loadApiKey());
  if (!apiKey) {
    printError("No API key found. Set VENT_API_KEY, run `npx vent-hq login`, or pass --api-key.");
    return 2;
  }
  log(`api-key resolved (${apiKey.slice(0, 8)}…)`);

  // 2. Parse config
  let config: unknown;
  try {
    if (args.file) {
      log(`reading config file: ${args.file}`);
      const raw = await fs.readFile(args.file, "utf-8");
      config = JSON.parse(raw);
      log(`config parsed — keys: ${Object.keys(config as Record<string, unknown>).join(", ")}`);
    } else if (args.config) {
      config = JSON.parse(args.config);
      log("config parsed from --config flag");
    } else {
      printError("Provide --config '{...}' or -f <file>.");
      return 2;
    }
  } catch (err) {
    printError(`Invalid config JSON: ${(err as Error).message}`);
    return 2;
  }

  // 2b. Filter to single test if --test is set
  if (args.test) {
    const cfg = config as { conversation_tests?: Array<{ name?: string }>; red_team_tests?: Array<{ name?: string }>; load_test?: unknown };
    if (cfg.load_test) {
      printError("--test only works with conversation_tests or red_team_tests, not load_test.");
      return 2;
    }
    const convTests = cfg.conversation_tests ?? [];
    const redTests = cfg.red_team_tests ?? [];
    if (convTests.length === 0 && redTests.length === 0) {
      printError("--test requires conversation_tests or red_team_tests in config.");
      return 2;
    }
    // Search both arrays for the named test
    const convMatch = convTests.filter((t, i) => (t.name ?? `test-${i}`) === args.test);
    const redMatch = redTests.filter((t, i) => (t.name ?? `red-${i}`) === args.test);
    if (convMatch.length === 0 && redMatch.length === 0) {
      const available = [
        ...convTests.map((t, i) => t.name ?? `test-${i}`),
        ...redTests.map((t, i) => t.name ?? `red-${i}`),
      ].join(", ");
      printError(`Test "${args.test}" not found. Available: ${available}`);
      return 2;
    }
    if (convMatch.length > 0) {
      cfg.conversation_tests = convMatch;
      cfg.red_team_tests = undefined;
    } else {
      cfg.red_team_tests = redMatch;
      cfg.conversation_tests = undefined;
    }
    log(`filtered to test: ${args.test}`);
  }

  // 2c. Auto-assign a free port for local agents so parallel runs don't collide
  const cfg = config as { connection?: { start_command?: string; agent_port?: number } };
  if (cfg.connection?.start_command) {
    const freePort = await findFreePort();
    cfg.connection.agent_port = freePort;
    log(`auto-port assigned: ${freePort}`);
  }

  // 3. Submit run
  log("submitting run to API…");
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
    log(`API response status: ${res.status}`);
    submitResult = (await res.json()) as typeof submitResult;
  } catch (err) {
    log(`submit error: ${(err as Error).message}`);
    printError(`Submit failed: ${(err as Error).message}`);
    return 2;
  }

  const { run_id } = submitResult;
  if (!run_id) {
    log(`no run_id in response: ${JSON.stringify(submitResult)}`);
    printError("Server returned no run_id. Response: " + JSON.stringify(submitResult));
    return 2;
  }
  log(`run created: ${run_id} status=${submitResult.status} has_relay=${!!submitResult.relay_config}`);
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
        check: `npx vent-hq status ${run_id} --json`,
      }) + "\n"
    );
    return 0;
  }

  // 5. Start relay if needed (local agent)
  let relay: RelayHandle | null = null;
  if (submitResult.relay_config) {
    log(`starting relay — agent_port=${submitResult.relay_config.agent_port} start_command="${submitResult.relay_config.start_command}" health=${submitResult.relay_config.health_endpoint}`);
    printInfo("Starting relay for local agent…");
    printInfo("Connecting to Vent cloud relay (timeout: 30s)…");
    try {
      relay = await startRelay(submitResult.relay_config);
      log("relay connected, agent healthy, run activated");
      printInfo("Relay connected, agent started.");
    } catch (err) {
      const msg = (err as Error).message;
      log(`relay error: ${msg}`);
      printError(`Relay failed: ${msg}`);
      return 2;
    }
  }

  // 6. Stream results
  log(`connecting to SSE stream for run ${run_id}…`);
  printInfo(`Streaming results for run ${run_id}…`);
  const abortController = new AbortController();
  let exitCode = 0;
  const testResults: SSEEvent[] = [];
  let runCompleteData: Record<string, unknown> | null = null;

  const onSignal = () => {
    log("received SIGINT/SIGTERM — aborting stream");
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    let eventCount = 0;
    for await (const event of streamRunEvents(run_id, apiKey, abortController.signal)) {
      eventCount++;
      const meta = (event.metadata_json ?? {}) as Record<string, unknown>;
      log(`event #${eventCount}: type=${event.event_type} meta_keys=[${Object.keys(meta).join(",")}] message="${event.message ?? ""}"`);
      printEvent(event, args.json);

      if (event.event_type === "test_completed") {
        testResults.push(event);
        log(`test_completed: name=${meta.test_name} status=${meta.status} duration=${meta.duration_ms}ms completed=${meta.completed}/${meta.total}`);
      }

      if (event.event_type === "run_complete") {
        runCompleteData = meta;
        const status = meta.status as string | undefined;
        exitCode = status === "pass" ? 0 : 1;
        log(`run_complete: status=${status} exitCode=${exitCode}`);
      }
    }
    log(`SSE stream ended — received ${eventCount} events total`);
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      log(`stream error: ${(err as Error).message}`);
      printError(`Stream error: ${(err as Error).message}`);
      exitCode = 2;
    } else {
      log("stream aborted (user signal)");
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (relay) {
      log("cleaning up relay…");
      await relay.cleanup();
      log("relay cleaned up");
    }
  }

  // 7. Print summary
  log(`summary: testResults=${testResults.length} runComplete=${!!runCompleteData} exitCode=${exitCode}`);
  if (runCompleteData && testResults.length > 0) {
    printSummary(testResults, runCompleteData, run_id, args.json);
  }

  log(`exiting with code ${exitCode}`);
  return exitCode;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address();
      const port = (addr as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
