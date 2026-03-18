import { writeFileSync } from "node:fs";
import type { FormattedConversationResult } from "@vent/shared";
import type { SSEEvent } from "./sse.js";

const isTTY = process.stdout.isTTY;

let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function debug(msg: string): void {
  if (!_verbose) return;
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[vent ${ts}] ${msg}\n`);
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

// ANSI helpers
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const blue = (s: string) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s);

export function printEvent(event: SSEEvent, jsonMode: boolean): void {
  if (jsonMode) {
    stdoutSync(JSON.stringify(event) + "\n");
    return;
  }

  // Non-TTY (coding agents): don't write individual events to stdout.
  // Coding agents read all stdout at once when the process exits.
  // Instead, printSummary writes one clean summary JSON at the end.
  if (!isTTY) {
    // Progress updates on stderr so they're visible in logs but don't pollute stdout
    const meta = (event.metadata_json ?? {}) as Record<string, unknown>;
    if (event.event_type === "test_completed") {
      const name = (meta.test_name as string) ?? "test";
      const status = (meta.status as string) ?? "unknown";
      const durationMs = meta.duration_ms as number | undefined;
      const duration = durationMs != null ? (durationMs / 1000).toFixed(1) + "s" : "";
      process.stderr.write(`  ${status === "completed" || status === "pass" ? "✔" : "✘"} ${name} ${duration}\n`);
    }
    return;
  }

  // TTY: formatted output
  const meta = (event.metadata_json ?? {}) as Record<string, unknown>;

  switch (event.event_type) {
    case "test_completed":
      printTestResult(meta);
      break;
    case "run_complete":
      printRunComplete(meta);
      break;
    case "test_started": {
      const name = (meta.test_name as string) ?? "test";
      process.stderr.write(dim(`  ▸ ${name}…`) + "\n");
      break;
    }
    default:
      process.stderr.write(dim(`  [${event.event_type}]`) + "\n");
  }
}

function printTestResult(meta: Record<string, unknown>): void {
  const result = meta.result as FormattedConversationResult | undefined;

  const testName = result?.name ?? (meta.test_name as string) ?? "test";
  const testStatus = result?.status ?? (meta.status as string);
  const durationMs = result?.duration_ms ?? (meta.duration_ms as number | undefined);

  const statusIcon = testStatus === "completed" || testStatus === "pass" ? green("✔") : red("✘");
  const duration = durationMs != null ? (durationMs / 1000).toFixed(1) + "s" : "—";

  const parts = [statusIcon, bold(testName), dim(duration)];

  if (result?.behavior?.intent_accuracy) {
    parts.push(`intent: ${result.behavior.intent_accuracy.score}`);
  }
  if (result?.latency?.p50_ttfw_ms != null) {
    parts.push(`p50: ${result.latency.p50_ttfw_ms}ms`);
  }

  stdoutSync(parts.join("  ") + "\n");
}

function printRunComplete(meta: Record<string, unknown>): void {
  const status = meta.status as string;

  const agg = meta.aggregate as { conversation_tests?: { passed?: number; failed?: number; total?: number }; red_team_tests?: { passed?: number; failed?: number; total?: number } } | undefined;
  const redTeam = agg?.red_team_tests;
  const counts = redTeam ?? agg?.conversation_tests;
  const total = (meta.total_tests as number | undefined) ?? counts?.total;
  const passed = (meta.passed_tests as number | undefined) ?? counts?.passed;
  const failed = (meta.failed_tests as number | undefined) ?? counts?.failed;

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
  testResults: SSEEvent[],
  runComplete: Record<string, unknown>,
  runId: string,
  jsonMode: boolean,
): void {
  // Build test results summary — pass through the full FormattedConversationResult
  // so coding agents have complete context on latency, behavior, transcript, etc.
  const allTests = testResults.map((e) => {
    const meta = e.metadata_json ?? {};
    const r = meta.result as FormattedConversationResult | undefined;
    if (r) return r;
    // Fallback for events without a full result object
    return {
      name: (meta.test_name as string) ?? "test",
      status: (meta.status as string) ?? "unknown",
      duration_ms: meta.duration_ms as number,
      error: null,
    };
  });

  const agg = runComplete.aggregate as { conversation_tests?: { passed?: number; failed?: number; total?: number }; red_team_tests?: { passed?: number; failed?: number; total?: number } } | undefined;
  const counts = agg?.red_team_tests ?? agg?.conversation_tests;

  const summaryData = {
    run_id: runId,
    status: runComplete.status,
    total: runComplete.total_tests ?? counts?.total,
    passed: runComplete.passed_tests ?? counts?.passed,
    failed: runComplete.failed_tests ?? counts?.failed,
    tests: allTests,
    check: `npx vent-hq status ${runId} --json`,
  };

  // Non-TTY (coding agents) or --json: write single summary JSON to stdout.
  // Uses stdoutSync to bypass Node.js async pipe buffering.
  if (jsonMode || !isTTY) {
    stdoutSync(JSON.stringify(summaryData, null, 2) + "\n");
    return;
  }

  // TTY: list failed tests with details
  const failures = allTests.filter((t) => t.status && t.status !== "completed" && t.status !== "pass");

  if (failures.length > 0) {
    stdoutSync("\n" + bold("Failed tests:") + "\n");
    for (const t of failures) {
      const duration = t.duration_ms != null ? (t.duration_ms / 1000).toFixed(1) + "s" : "—";
      const parts = [red("✘"), bold(t.name), dim(duration)];
      if (t.intent_accuracy != null) {
        parts.push(`intent: ${t.intent_accuracy}`);
      }
      stdoutSync("  " + parts.join("  ") + "\n");
    }
  }

  process.stderr.write(dim(`Full details: vent status ${runId} --json`) + "\n");
}

export function printError(message: string): void {
  const line = red(bold("error")) + ` ${message}\n`;
  process.stderr.write(line);
  // Also write to stdout so coding agents (which may only capture stdout) see errors
  if (!isTTY) {
    stdoutSync(line);
  }
}

export function printInfo(message: string): void {
  process.stderr.write(blue("▸") + ` ${message}\n`);
}

export function printSuccess(message: string): void {
  process.stderr.write(green("✔") + ` ${message}\n`);
}

export function printWarn(message: string): void {
  process.stderr.write(yellow("⚠") + ` ${message}\n`);
}
