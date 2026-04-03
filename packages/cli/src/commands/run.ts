import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { apiFetch, ApiError, ensurePlatformConnection } from "../lib/api.js";
import { deviceAuthFlow } from "../lib/auth.js";
import { streamRunEvents } from "../lib/sse.js";
import { printEvent, printError, printInfo, printSummary, debug, setVerbose } from "../lib/output.js";
import { loadAccessToken, saveAccessToken } from "../lib/config.js";
import { saveRunHistory } from "../lib/run-history.js";
import { resolveRemotePlatformConfig } from "../lib/platform-connections.js";
import type { SSEEvent } from "../lib/sse.js";

const isTTY = process.stdout.isTTY;

interface RunArgs {
  config?: string;
  file?: string;
  call?: string;
  session?: string;
  accessToken?: string;
  json: boolean;
  submit: boolean;
  verbose?: boolean;
}

export async function runCommand(args: RunArgs): Promise<number> {
  if (args.verbose) setVerbose(true);
  debug(`start args=${JSON.stringify({ file: args.file, call: args.call, session: args.session, json: args.json, submit: args.submit })}`);

  // 1. Resolve Vent access token
  const accessToken = args.accessToken ?? (await loadAccessToken());
  if (!accessToken) {
    printError("No Vent access token found. Set VENT_ACCESS_TOKEN, run `npx vent-hq login`, or pass --access-token.");
    return 2;
  }
  debug(`access-token resolved (${accessToken.slice(0, 8)}…)`);

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

  // 2b. Filter to single call if --call is set
  if (args.call) {
    const cfg = config as { conversation_calls?: Array<{ name?: string }> };
    const convCalls = cfg.conversation_calls ?? [];
    if (convCalls.length === 0) {
      printError("--call requires conversation_calls in config.");
      return 2;
    }
    const convMatch = convCalls.filter((t, i) => (t.name ?? `call-${i}`) === args.call);
    if (convMatch.length === 0) {
      const available = convCalls.map((t, i) => t.name ?? `call-${i}`).join(", ");
      printError(`Call "${args.call}" not found. Available: ${available}`);
      return 2;
    }
    cfg.conversation_calls = convMatch;
    debug(`filtered to call: ${args.call}`);
  }

  // 2c. Resolve remote platform credentials from local env and keep them local to the CLI.
  // The CLI will upsert a saved platform connection and submit only the resulting ID.
  let resolvedRemotePlatform = null;
  try {
    resolvedRemotePlatform = resolveRemotePlatformConfig(config);
  } catch (err) {
    printError((err as Error).message);
    return 2;
  }

  // 2d. Enforce platform concurrency limits
  const adapterForLimit = (config as { connection?: { adapter?: string } }).connection?.adapter;
  const platformProvider = resolvedRemotePlatform?.provider;
  const defaultLimits: Record<string, number> = { livekit: 5, vapi: 10, bland: 10, elevenlabs: 5, retell: 5 };
  const providerKey = platformProvider ?? adapterForLimit;
  const concurrencyLimit = providerKey ? defaultLimits[providerKey] : undefined;
  if (concurrencyLimit) {
    const convCalls = (config as { conversation_calls?: Array<{ repeat?: number }> }).conversation_calls ?? [];
    const totalConcurrent = convCalls.reduce((sum, t) => sum + (t.repeat ?? 1), 0);
    if (totalConcurrent > concurrencyLimit) {
      printError(
        `Too many concurrent calls (${totalConcurrent}) for ${providerKey} (limit: ${concurrencyLimit}). ` +
        `Reduce call count or use --call to run a subset. Calls exceeding the limit will hang forever.`
      );
      return 2;
    }
  }

  const connection = config as {
    connection?: {
      start_command?: string;
      agent_url?: string;
      adapter?: string;
    };
  };
  const isLocalStartCommand = !!connection.connection?.start_command && !connection.connection?.agent_url;
  if (isLocalStartCommand && !args.session) {
    printError(
      "Local runs require --session <agent-session-id>. Start the shared relay once with `npx vent-hq agent start -f <suite.json>`.",
    );
    return 2;
  }

  // 3. Submit run
  debug("submitting run to API…");
  printInfo("Submitting run…");
  let submitResult: {
    run_id: string;
    status: string;
  };

  let activeAccessToken = accessToken;
  const configConnection = config as {
    connection?: {
      adapter?: string;
      platform?: Record<string, unknown>;
      platform_connection_id?: string;
    };
  };

  async function prepareConfigForSubmit(currentAccessToken: string): Promise<void> {
    if (!configConnection.connection) return;

    if (resolvedRemotePlatform) {
      debug(`ensuring saved ${resolvedRemotePlatform.provider} connection…`);
      const ensured = await ensurePlatformConnection(currentAccessToken, resolvedRemotePlatform);
      configConnection.connection.platform_connection_id = ensured.platform_connection_id;
      debug(
        `saved connection ready id=${ensured.platform_connection_id} created=${ensured.created} updated=${ensured.updated}`,
      );
    }

    if ("platform" in configConnection.connection) {
      delete configConnection.connection.platform;
    }
  }

  async function submitPrepared(currentAccessToken: string): Promise<typeof submitResult> {
    await prepareConfigForSubmit(currentAccessToken);
    const res = await apiFetch("/runs/submit", currentAccessToken, {
      method: "POST",
      body: JSON.stringify({
        config,
        agent_session_id: args.session,
      }),
    });
    debug(`API response status: ${res.status}`);
    return res.json() as Promise<typeof submitResult>;
  }

  try {
    submitResult = await submitPrepared(activeAccessToken);
  } catch (err) {
    // Auto-trigger login when anonymous run limit is hit
    if (err instanceof ApiError && err.status === 403) {
      const body = err.body as { code?: string } | undefined;
      if (body?.code === "USAGE_LIMIT") {
        printInfo(
          "To prevent abuse, we require a verified account after 10 runs. Opening browser to sign in...",
          { force: true },
        );
        const authResult = await deviceAuthFlow();
        if (!authResult.ok) {
          printError("Authentication failed. Run `npx vent-hq login` manually.");
          return 1;
        }
        activeAccessToken = authResult.accessToken;
        await saveAccessToken(activeAccessToken);
        printInfo("Authenticated! Retrying run submission...", { force: true });
        try {
          submitResult = await submitPrepared(activeAccessToken);
        } catch (retryErr) {
          debug(`retry submit error: ${(retryErr as Error).message}`);
          printError(`Submit failed after login: ${(retryErr as Error).message}`);
          return 2;
        }
      } else {
        debug(`submit error: ${(err as Error).message}`);
        printError(`Submit failed: ${(err as Error).message}`);
        return 2;
      }
    } else {
      debug(`submit error: ${(err as Error).message}`);
      printError(`Submit failed: ${(err as Error).message}`);
      return 2;
    }
  }

  const { run_id } = submitResult;
  if (!run_id) {
    debug(`no run_id in response: ${JSON.stringify(submitResult)}`);
    printError("Server returned no run_id. Response: " + JSON.stringify(submitResult));
    return 2;
  }
  debug(`run created: ${run_id} status=${submitResult.status}`);
  printInfo(`Run ${run_id} created.`);

  // 4. Handle --submit (fire-and-forget)
  if (args.submit) {
    process.stdout.write(
      JSON.stringify({
        run_id,
        status: submitResult.status,
        check: `npx vent-hq status ${run_id} --json`,
      }) + "\n"
    );
    return 0;
  }

  // 5. Stream results
  debug(`connecting to SSE stream for run ${run_id}…`);
  printInfo(`Streaming results for run ${run_id}…`);
  const abortController = new AbortController();
  let exitCode = 0;
  const callResults: SSEEvent[] = [];
  let runCompleteData: Record<string, unknown> | null = null;

  const onSignal = () => {
    debug("received SIGINT/SIGTERM — aborting stream");
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    let eventCount = 0;
    for await (const event of streamRunEvents(run_id, activeAccessToken, abortController.signal)) {
      eventCount++;
      const meta = (event.metadata_json ?? {}) as Record<string, unknown>;
      debug(`event #${eventCount}: type=${event.event_type} meta_keys=[${Object.keys(meta).join(",")}] message="${event.message ?? ""}"`);
      printEvent(event, args.json);

      if (event.event_type === "call_completed") {
        callResults.push(event);
        debug(`call_completed: name=${meta.call_name} status=${meta.status} duration=${meta.duration_ms}ms completed=${meta.completed}/${meta.total}`);
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
  }

  // 6. Print summary
  debug(`summary: callResults=${callResults.length} runComplete=${!!runCompleteData} exitCode=${exitCode}`);
  if (runCompleteData) {
    printSummary(callResults, runCompleteData, run_id, args.json);
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

  // 7. Save run history locally
  if (runCompleteData) {
    const savedPath = await saveRunHistory(run_id, callResults, runCompleteData);
    if (savedPath) {
      debug(`run saved to ${savedPath}`);
      printInfo(`Run saved to ${savedPath}`);
    }
  }

  debug(`exiting with code ${exitCode}`);

  // Force exit — the fetch TCP socket from the SSE stream keeps the event loop
  // alive indefinitely. Without this, the process hangs after calls complete,
  // Claude Code eventually kills it, and stdout capture is lost.
  process.exit(exitCode);
}
