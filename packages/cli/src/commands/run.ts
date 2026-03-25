import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import * as net from "node:net";
import { apiFetch } from "../lib/api.js";
import { streamRunEvents } from "../lib/sse.js";
import { startRelay } from "../lib/relay.js";
import { printEvent, printError, printInfo, printSummary, debug, setVerbose } from "../lib/output.js";
import { loadApiKey } from "../lib/config.js";
import { saveRunHistory } from "../lib/run-history.js";
import type { RelayHandle } from "../lib/relay.js";
import type { SSEEvent } from "../lib/sse.js";

const isTTY = process.stdout.isTTY;

interface RunArgs {
  config?: string;
  file?: string;
  test?: string;
  apiKey?: string;
  json: boolean;
  submit: boolean;
  verbose?: boolean;
}

export async function runCommand(args: RunArgs): Promise<number> {
  if (args.verbose) setVerbose(true);
  debug(`start args=${JSON.stringify({ file: args.file, test: args.test, json: args.json, submit: args.submit })}`);

  // 1. Resolve API key
  const apiKey = args.apiKey ?? (await loadApiKey());
  if (!apiKey) {
    printError("No API key found. Set VENT_API_KEY, run `npx vent-hq login`, or pass --api-key.");
    return 2;
  }
  debug(`api-key resolved (${apiKey.slice(0, 8)}…)`);

  // 2. Parse config
  let config: unknown;
  try {
    if (args.file) {
      debug(`reading config file: ${args.file}`);
      const raw = await fs.readFile(args.file, "utf-8");
      config = JSON.parse(raw);
      debug(`config parsed — keys: ${Object.keys(config as Record<string, unknown>).join(", ")}`);
    } else if (args.config) {
      config = JSON.parse(args.config);
      debug("config parsed from --config flag");
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
    debug(`filtered to test: ${args.test}`);
  }

  // 2c. Resolve platform API key from local env so the worker doesn't need it
  const cfgPlatform = (config as { connection?: { platform?: Record<string, unknown> & { api_key_env?: string; api_key?: string; provider?: string } } });
  if (cfgPlatform.connection?.platform?.api_key_env && !cfgPlatform.connection.platform.api_key) {
    const envName = cfgPlatform.connection.platform.api_key_env;
    const resolved = process.env[envName];
    if (!resolved) {
      printError(`Platform API key not found: environment variable ${envName} is not set.`);
      return 2;
    }
    cfgPlatform.connection.platform.api_key = resolved;
    debug(`resolved platform API key from ${envName}`);
  }

  // 2c2. Resolve LiveKit-specific env vars (URL, API key, API secret) from user's local env
  const connAdapter = (config as { connection?: { adapter?: string } }).connection?.adapter;
  if ((connAdapter === "webrtc" || connAdapter === "livekit")) {
    const plat = cfgPlatform.connection?.platform ?? {};
    if (!plat.livekit_url) {
      const url = process.env["LIVEKIT_URL"];
      if (!url) { printError("LiveKit adapter requires LIVEKIT_URL environment variable."); return 2; }
      plat.livekit_url = url;
    }
    if (!plat.api_key) {
      const key = process.env[plat.api_key_env ?? "LIVEKIT_API_KEY"];
      if (!key) { printError("LiveKit adapter requires LIVEKIT_API_KEY environment variable."); return 2; }
      plat.api_key = key;
    }
    if (!plat.api_secret) {
      const secret = process.env["LIVEKIT_API_SECRET"];
      if (!secret) { printError("LiveKit adapter requires LIVEKIT_API_SECRET environment variable."); return 2; }
      plat.api_secret = secret;
    }
    // Ensure platform is set on connection
    if (!cfgPlatform.connection!.platform) {
      (cfgPlatform.connection as Record<string, unknown>).platform = { provider: "livekit", ...plat };
    }
    debug("resolved LiveKit credentials from local env");
  }

  // 2d. Enforce platform concurrency limits
  const adapterForLimit = (config as { connection?: { adapter?: string } }).connection?.adapter;
  const platformProvider = cfgPlatform.connection?.platform?.provider;
  const defaultLimits: Record<string, number> = { livekit: 5, vapi: 10, bland: 10, elevenlabs: 5, retell: 5 };
  const providerKey = platformProvider ?? (adapterForLimit === "webrtc" ? "livekit" : adapterForLimit);
  const concurrencyLimit = providerKey ? defaultLimits[providerKey] : undefined;
  if (concurrencyLimit) {
    const convTests = (config as { conversation_tests?: Array<{ repeat?: number }> }).conversation_tests ?? [];
    const redTests = (config as { red_team_tests?: Array<{ repeat?: number }> }).red_team_tests ?? [];
    const allTests = [...convTests, ...redTests];
    const totalConcurrent = allTests.reduce((sum, t) => sum + (t.repeat ?? 1), 0);
    if (totalConcurrent > concurrencyLimit) {
      printError(
        `Too many concurrent tests (${totalConcurrent}) for ${providerKey} (limit: ${concurrencyLimit}). ` +
        `Reduce test count or use --test to run a subset. Tests exceeding the limit will hang forever.`
      );
      return 2;
    }
  }

  // 2e. Auto-assign a free port for local agents so parallel runs don't collide
  const cfg = config as { connection?: { start_command?: string; agent_port?: number } };
  if (cfg.connection?.start_command) {
    const freePort = await findFreePort();
    cfg.connection.agent_port = freePort;
    debug(`auto-port assigned: ${freePort}`);
  }

  // 3. Submit run
  debug("submitting run to API…");
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
    debug(`API response status: ${res.status}`);
    submitResult = (await res.json()) as typeof submitResult;
  } catch (err) {
    debug(`submit error: ${(err as Error).message}`);
    printError(`Submit failed: ${(err as Error).message}`);
    return 2;
  }

  const { run_id } = submitResult;
  if (!run_id) {
    debug(`no run_id in response: ${JSON.stringify(submitResult)}`);
    printError("Server returned no run_id. Response: " + JSON.stringify(submitResult));
    return 2;
  }
  debug(`run created: ${run_id} status=${submitResult.status} has_relay=${!!submitResult.relay_config}`);
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
    debug(`starting relay — agent_port=${submitResult.relay_config.agent_port} start_command="${submitResult.relay_config.start_command}" health=${submitResult.relay_config.health_endpoint}`);
    printInfo("Starting relay for local agent…");
    printInfo("Connecting to Vent cloud relay (timeout: 30s)…");
    try {
      relay = await startRelay(submitResult.relay_config);
      debug("relay connected, agent healthy, run activated");
      printInfo("Relay connected, agent started.");
    } catch (err) {
      const msg = (err as Error).message;
      debug(`relay error: ${msg}`);
      printError(`Relay failed: ${msg}`);
      return 2;
    }
  }

  // 6. Stream results
  debug(`connecting to SSE stream for run ${run_id}…`);
  printInfo(`Streaming results for run ${run_id}…`);
  const abortController = new AbortController();
  let exitCode = 0;
  const testResults: SSEEvent[] = [];
  let runCompleteData: Record<string, unknown> | null = null;

  const onSignal = () => {
    debug("received SIGINT/SIGTERM — aborting stream");
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    let eventCount = 0;
    for await (const event of streamRunEvents(run_id, apiKey, abortController.signal)) {
      eventCount++;
      const meta = (event.metadata_json ?? {}) as Record<string, unknown>;
      debug(`event #${eventCount}: type=${event.event_type} meta_keys=[${Object.keys(meta).join(",")}] message="${event.message ?? ""}"`);
      printEvent(event, args.json);

      if (event.event_type === "test_completed") {
        testResults.push(event);
        debug(`test_completed: name=${meta.test_name} status=${meta.status} duration=${meta.duration_ms}ms completed=${meta.completed}/${meta.total}`);
      }

      if (event.event_type === "run_complete") {
        runCompleteData = meta;
        const status = meta.status as string | undefined;
        exitCode = status === "pass" ? 0 : 1;
        debug(`run_complete: status=${status} exitCode=${exitCode}`);
      }
    }
    debug(`SSE stream ended — received ${eventCount} events total`);
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      debug(`stream error: ${(err as Error).message}`);
      printError(`Stream error: ${(err as Error).message}`);
      exitCode = 2;
    } else {
      debug("stream aborted (user signal)");
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (relay) {
      debug("cleaning up relay…");
      await relay.cleanup();
      debug("relay cleaned up");
    }
  }

  // 7. Print summary
  debug(`summary: testResults=${testResults.length} runComplete=${!!runCompleteData} exitCode=${exitCode}`);
  if (runCompleteData) {
    printSummary(testResults, runCompleteData, run_id, args.json);
  } else if (!isTTY) {
    // Fallback: if SSE stream ended without run_complete, still write something to stdout
    // so coding agents don't see empty output / "undefined"
    try {
      writeFileSync(1, JSON.stringify({
        run_id,
        status: exitCode === 0 ? "pass" : "error",
        error: "Stream ended without run_complete event",
        check: `npx vent-hq status ${run_id} --json`,
      }) + "\n");
    } catch {
      process.stdout.write(JSON.stringify({ run_id, status: "error" }) + "\n");
    }
  }

  // 8. Save run history locally
  if (runCompleteData) {
    const savedPath = await saveRunHistory(run_id, testResults, runCompleteData);
    if (savedPath) {
      debug(`run saved to ${savedPath}`);
      printInfo(`Run saved to ${savedPath}`);
    }
  }

  debug(`exiting with code ${exitCode}`);

  // Force exit — the fetch TCP socket from the SSE stream keeps the event loop
  // alive indefinitely. Without this, the process hangs after tests complete,
  // Claude Code eventually kills it, and stdout capture is lost.
  process.exit(exitCode);
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
