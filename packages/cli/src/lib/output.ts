import { writeFileSync } from "node:fs";
import { formatConversationResult, type FormattedConversationResult } from "@vent/shared";
import type { SSEEvent } from "./sse.js";

const isTTY = process.stdout.isTTY;

let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function debug(msg: string): void {
  if (!_verbose) return;
  const ts = new Date().toISOString().slice(11, 23);
  stdoutSync(`[vent ${ts}] ${msg}\n`);
}

export function isVerbose(): boolean {
  return _verbose;
}

/**
 * Synchronous write to stdout. On POSIX, process.stdout.write() to a pipe is
 * ASYNC — if the process exits before the buffer drains, the data is lost and
 * the coding agent sees "undefined". writeFileSync to /dev/stdout bypasses
 * Node's stream buffering and writes synchronously (like shell `echo`).
 */
function stdoutSync(data: string): void {
  if (isTTY) {
    process.stdout.write(data);
  } else {
    try {
      // Write directly to fd 1 — no path resolution, no new fd.
      // This is the most reliable synchronous stdout write on POSIX.
      writeFileSync(1, data);
    } catch {
      process.stdout.write(data);
    }
  }
}

export function writeJsonStdout(value: unknown): void {
  stdoutSync(JSON.stringify(value, null, 2) + "\n");
}

// ANSI helpers
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const blue = (s: string) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s);

interface RunSummaryJsonOptions {
  runId: string;
  status: unknown;
  total?: unknown;
  passed?: unknown;
  failed?: unknown;
  formattedCalls?: Array<FormattedConversationResult | Record<string, unknown>>;
  rawCalls?: unknown[];
  verbose?: boolean;
  runDetails?: {
    created_at?: unknown;
    started_at?: unknown;
    finished_at?: unknown;
    duration_ms?: unknown;
    error_text?: unknown;
    aggregate?: unknown;
  };
}

export function printEvent(event: SSEEvent): void {
  // Non-TTY (coding agents): don't write individual events to stdout.
  // Coding agents read all stdout at once when the process exits.
  // printSummary writes one clean summary JSON at the end.
  if (!isTTY) return;

  const meta = (event.metadata_json ?? {}) as Record<string, unknown>;

  switch (event.event_type) {
    case "call_completed":
      printCallResult(meta);
      break;
    case "run_complete":
      printRunComplete(meta);
      break;
    case "call_started": {
      const name = (meta.call_name as string) ?? "call";
      stdoutSync(dim(`  ▸ ${name}…`) + "\n");
      break;
    }
    default:
      stdoutSync(dim(`  [${event.event_type}]`) + "\n");
  }
}

function printCallResult(meta: Record<string, unknown>): void {
  const result = meta.result as FormattedConversationResult | undefined;

  const callName = result?.name ?? (meta.call_name as string) ?? "call";
  const callStatus = result?.status ?? (meta.status as string);
  const durationMs = result?.duration_ms ?? (meta.duration_ms as number | undefined);

  const statusIcon = callStatus === "completed" || callStatus === "pass" ? green("✔") : red("✘");
  const duration = durationMs != null ? (durationMs / 1000).toFixed(1) + "s" : "—";

  const parts = [statusIcon, bold(callName), dim(duration)];

  if (result?.latency?.p50_response_time_ms != null) {
    parts.push(`p50: ${result.latency.p50_response_time_ms}ms`);
  }

  if (result?.call_metadata?.transfer_attempted) {
    const transferLabel = result.call_metadata.transfer_completed ? "transfer: completed" : "transfer: attempted";
    parts.push(transferLabel);
  }

  stdoutSync(parts.join("  ") + "\n");

  const providerCallId = result?.call_metadata?.provider_call_id;
  const providerSessionId = result?.call_metadata?.provider_session_id;
  if (providerCallId) {
    stdoutSync(dim(`    provider id: ${providerCallId}`) + "\n");
  } else if (providerSessionId) {
    stdoutSync(dim(`    provider session: ${providerSessionId}`) + "\n");
  }

  const recordingUrl = result?.call_metadata?.recording_url;
  if (recordingUrl) {
    stdoutSync(dim(`    recording: ${recordingUrl}`) + "\n");
  }

  const debugUrls = result?.call_metadata?.provider_debug_urls;
  if (debugUrls) {
    for (const [label, url] of Object.entries(debugUrls)) {
      stdoutSync(dim(`    ${label}: ${url}`) + "\n");
    }
  }
}

function printRunComplete(meta: Record<string, unknown>): void {
  const status = meta.status as string;

  const agg = meta.aggregate as { conversation_calls?: { passed?: number; failed?: number; total?: number } } | undefined;
  const counts = agg?.conversation_calls;
  const total = (meta.total_calls as number | undefined) ?? counts?.total;
  const passed = (meta.passed_calls as number | undefined) ?? counts?.passed;
  const failed = (meta.failed_calls as number | undefined) ?? counts?.failed;

  stdoutSync("\n");

  if (status === "pass") {
    stdoutSync(green(bold("Run passed")) + "\n");
  } else {
    stdoutSync(red(bold("Run failed")) + "\n");
  }

  if (total != null) {
    const parts: string[] = [];
    if (passed) parts.push(green(`${passed} passed`));
    if (failed) parts.push(red(`${failed} failed`));
    parts.push(`${total} total`);
    stdoutSync(parts.join(dim(" · ")) + "\n");
  }
}

export function printSummary(
  callResults: SSEEvent[],
  runComplete: Record<string, unknown>,
  runId: string,
  options: {
    verbose?: boolean;
    rawCalls?: unknown[];
    runDetails?: RunSummaryJsonOptions["runDetails"];
  } = {},
): void {
  const allCalls = options.rawCalls
    ? formatRawCalls(options.rawCalls, options.verbose ?? false)
    : callResults.map((e) => {
      const meta = e.metadata_json ?? {};
      const r = meta.result as FormattedConversationResult | undefined;
      if (r) return r;
      // Fallback for events without a full result object
      return {
        name: (meta.call_name as string) ?? "call",
        status: (meta.status as string) ?? "unknown",
        duration_ms: meta.duration_ms as number,
        error: null,
      };
    });

  const agg = runComplete.aggregate as { conversation_calls?: { passed?: number; failed?: number; total?: number } } | undefined;
  const counts = agg?.conversation_calls;
  const summaryData = buildRunSummaryJson({
    runId,
    status: runComplete.status,
    total: runComplete.total_calls ?? counts?.total,
    passed: runComplete.passed_calls ?? counts?.passed,
    failed: runComplete.failed_calls ?? counts?.failed,
    formattedCalls: allCalls,
    verbose: options.verbose,
    runDetails: options.runDetails ?? { aggregate: runComplete.aggregate },
  });

  // Non-TTY (coding agents): write single summary JSON to stdout.
  if (!isTTY) {
    stdoutSync(JSON.stringify(summaryData, null, 2) + "\n");
    return;
  }

  // TTY: list failed calls with details
  const failures = allCalls.filter((t) => t.status && t.status !== "completed" && t.status !== "pass");

  if (failures.length > 0) {
    stdoutSync("\n" + bold("Failed calls:") + "\n");
    for (const t of failures) {
      const duration = t.duration_ms != null ? (t.duration_ms / 1000).toFixed(1) + "s" : "—";
      const parts = [red("✘"), bold(t.name ?? "call"), dim(duration)];
      stdoutSync("  " + parts.join("  ") + "\n");
    }
  }

  stdoutSync(dim(`Full details: vent status ${runId}${options.verbose ? " --verbose" : ""}`) + "\n");
}

export function buildRunSummaryJson(options: RunSummaryJsonOptions): Record<string, unknown> {
  const calls = options.rawCalls
    ? formatRawCalls(options.rawCalls, options.verbose ?? false)
    : (options.formattedCalls ?? []);

  const summaryData: Record<string, unknown> = {
    run_id: options.runId,
    status: options.status,
    total: options.total,
    passed: options.passed,
    failed: options.failed,
    calls,
  };

  const details = options.runDetails;
  if (details?.created_at != null) summaryData["created_at"] = details.created_at;
  if (details?.started_at != null) summaryData["started_at"] = details.started_at;
  if (details?.finished_at != null) summaryData["finished_at"] = details.finished_at;
  if (details?.duration_ms != null) summaryData["duration_ms"] = details.duration_ms;
  if (details?.error_text != null) summaryData["error_text"] = details.error_text;
  if (details?.aggregate != null) summaryData["aggregate"] = details.aggregate;

  return summaryData;
}

function formatRawCalls(
  rawCalls: unknown[],
  verbose: boolean,
): Array<FormattedConversationResult | Record<string, unknown>> {
  return rawCalls.map((raw) => {
    const formatted = formatConversationResult(raw, { verbose });
    if (formatted) return formatted;

    const fallback = raw as Record<string, unknown>;
    return {
      name: typeof fallback["name"] === "string" ? fallback["name"] : "call",
      status: typeof fallback["status"] === "string" ? fallback["status"] : "unknown",
      duration_ms: typeof fallback["duration_ms"] === "number" ? fallback["duration_ms"] : undefined,
      error: typeof fallback["error"] === "string" ? fallback["error"] : null,
    };
  });
}

export function printError(message: string): void {
  const line = red(bold("error")) + ` ${message}\n`;
  stdoutSync(line);
}

export function printInfo(message: string, { force }: { force?: boolean } = {}): void {
  if (!force && !isTTY && !_verbose) return;
  const line = blue("▸") + ` ${message}\n`;
  stdoutSync(line);
}

export function printSuccess(message: string, { force }: { force?: boolean } = {}): void {
  if (!force && !isTTY && !_verbose) return;
  const line = green("✔") + ` ${message}\n`;
  stdoutSync(line);
}

export function printWarn(message: string, { force }: { force?: boolean } = {}): void {
  if (!force && !isTTY && !_verbose) return;
  const line = yellow("⚠") + ` ${message}\n`;
  stdoutSync(line);
}
