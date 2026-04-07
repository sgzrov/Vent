import * as fs from "node:fs/promises";
import { apiFetch, ApiError, ensurePlatformConnection } from "../lib/api.js";
import { deviceAuthFlow } from "../lib/auth.js";
import { streamRunEvents } from "../lib/sse.js";
import { printEvent, printError, printInfo, printSummary, printWarn, debug } from "../lib/output.js";
import { loadAccessToken, saveAccessToken } from "../lib/config.js";
import { saveRunHistory } from "../lib/run-history.js";
import { resolveRemotePlatformConfig } from "../lib/platform-connections.js";
import type { SSEEvent } from "../lib/sse.js";

const isTTY = process.stdout.isTTY;

interface RunArgs {
  file: string;
  call?: string;
  session?: string;
  verbose?: boolean;
}

export async function runCommand(args: RunArgs): Promise<number> {
  debug(`start args=${JSON.stringify({ file: args.file, session: args.session })}`);

  // 1. Resolve Vent access token
  const accessToken = await loadAccessToken();
  if (!accessToken) {
    printError("No Vent access token found. Set VENT_ACCESS_TOKEN, run `npx vent-hq login`, or pass --access-token.");
    return 2;
  }
  debug(`access-token resolved (${accessToken.slice(0, 8)}…)`);

  // 2. Parse suite file and extract call
  let config: unknown;
  try {
    debug(`reading suite file: ${args.file}`);
    const raw = await fs.readFile(args.file, "utf-8");
    const suite = JSON.parse(raw) as {
      connection?: unknown;
      calls?: Record<string, unknown>;
    };
    debug(`suite parsed — keys: ${Object.keys(suite).join(", ")}`);

    if (!suite.connection) {
      printError("Suite file must have a `connection` object.");
      return 2;
    }
    if (!suite.calls || typeof suite.calls !== "object" || Object.keys(suite.calls).length === 0) {
      printError("Suite file must have a `calls` map with at least one named call.");
      return 2;
    }

    const callNames = Object.keys(suite.calls);
    let callName: string;

    if (args.call) {
      if (!suite.calls[args.call]) {
        printError(`Call "${args.call}" not found. Available: ${callNames.join(", ")}`);
        return 2;
      }
      callName = args.call;
    } else if (callNames.length === 1) {
      callName = callNames[0]!;
    } else {
      printError(`Suite has ${callNames.length} calls. Use --call <name> to pick one: ${callNames.join(", ")}`);
      return 2;
    }

    debug(`selected call: ${callName}`);
    const call = { ...(suite.calls[callName] as Record<string, unknown>), name: callName };
    config = { connection: suite.connection, call };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      printError(`File not found: ${args.file}`);
      return 2;
    }
    printError(`Invalid suite JSON: ${(err as Error).message}`);
    return 2;
  }

  // 2b. Resolve remote platform credentials from local env and keep them local to the CLI.
  // The CLI will upsert a saved platform connection and submit only the resulting ID.
  let resolvedRemotePlatform = null;
  try {
    resolvedRemotePlatform = resolveRemotePlatformConfig(config);
  } catch (err) {
    printError((err as Error).message);
    return 2;
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

  // 4. Stream results
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
      printEvent(event);

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

      if (event.event_type === "error") {
        printError(event.message ?? "Stream connection lost");
        exitCode = 2;
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

  // 5. Print summary
  debug(`summary: callResults=${callResults.length} runComplete=${!!runCompleteData} exitCode=${exitCode}`);
  if (runCompleteData) {
    let rawRunDetails: Record<string, unknown> | null = null;
    if (args.verbose && !isTTY) {
      try {
        const res = await apiFetch(`/runs/${run_id}`, activeAccessToken);
        rawRunDetails = (await res.json()) as Record<string, unknown>;
      } catch (err) {
        debug(`verbose status fetch failed: ${(err as Error).message}`);
        printWarn("Verbose result fetch failed; falling back to streamed summary.");
      }
    }

    printSummary(callResults, runCompleteData, run_id, {
      verbose: args.verbose,
      rawCalls: Array.isArray(rawRunDetails?.["results"]) ? rawRunDetails["results"] as unknown[] : undefined,
      runDetails: rawRunDetails ? {
        created_at: rawRunDetails["created_at"],
        started_at: rawRunDetails["started_at"],
        finished_at: rawRunDetails["finished_at"],
        duration_ms: rawRunDetails["duration_ms"],
        error_text: rawRunDetails["error_text"],
        aggregate: rawRunDetails["aggregate"],
      } : undefined,
    });
  }

  // 6. Save run history locally
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
