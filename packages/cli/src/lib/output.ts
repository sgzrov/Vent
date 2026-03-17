import type { FormattedConversationResult } from "@vent/shared";
import type { SSEEvent } from "./sse.js";

const isTTY = process.stdout.isTTY;

// ANSI helpers
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const blue = (s: string) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s);

export function printEvent(event: SSEEvent, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(event) + "\n");
    return;
  }

  // Non-TTY (coding agents): write every event as a JSON line to stdout.
  // The agent reads all stdout at once when the process exits.
  // Without this, stdout can be empty → agent sees "undefined".
  if (!isTTY) {
    process.stdout.write(JSON.stringify(event) + "\n");
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

  process.stdout.write(parts.join("  ") + "\n");
}

function printRunComplete(meta: Record<string, unknown>): void {
  const status = meta.status as string;

  const agg = meta.aggregate as { conversation_tests?: { passed?: number; failed?: number; total?: number }; red_team_tests?: { passed?: number; failed?: number; total?: number } } | undefined;
  const redTeam = agg?.red_team_tests;
  const counts = redTeam ?? agg?.conversation_tests;
  const total = (meta.total_tests as number | undefined) ?? counts?.total;
  const passed = (meta.passed_tests as number | undefined) ?? counts?.passed;
  const failed = (meta.failed_tests as number | undefined) ?? counts?.failed;

  process.stdout.write("\n");

  if (status === "pass") {
    process.stdout.write(green(bold("Run passed")) + "\n");
  } else {
    process.stdout.write(red(bold("Run failed")) + "\n");
  }

  if (total != null) {
    const parts: string[] = [];
    if (passed) parts.push(green(`${passed} passed`));
    if (failed) parts.push(red(`${failed} failed`));
    parts.push(`${total} total`);
    process.stdout.write(parts.join(dim(" · ")) + "\n");
  }
}

export function printSummary(
  testResults: SSEEvent[],
  runComplete: Record<string, unknown>,
  runId: string,
  jsonMode: boolean,
): void {
  if (jsonMode) {
    const failedTests = testResults
      .filter((e) => {
        const meta = e.metadata_json ?? {};
        const r = meta.result as FormattedConversationResult | undefined;
        const status = r?.status ?? (meta.status as string);
        return status && status !== "completed" && status !== "pass";
      })
      .map((e) => {
        const meta = e.metadata_json ?? {};
        const r = meta.result as FormattedConversationResult | undefined;
        return {
          name: r?.name ?? (meta.test_name as string) ?? "test",
          status: r?.status ?? (meta.status as string),
          duration_ms: r?.duration_ms ?? (meta.duration_ms as number),
          intent_accuracy: r?.behavior?.intent_accuracy?.score,
          p50_ttfw_ms: r?.latency?.p50_ttfw_ms,
        };
      });

    const agg = runComplete.aggregate as { conversation_tests?: { passed?: number; failed?: number; total?: number }; red_team_tests?: { passed?: number; failed?: number; total?: number } } | undefined;
    const counts = agg?.red_team_tests ?? agg?.conversation_tests;

    process.stdout.write(
      JSON.stringify({
        event_type: "summary",
        data: {
          run_id: runId,
          status: runComplete.status,
          total: runComplete.total_tests ?? counts?.total,
          passed: runComplete.passed_tests ?? counts?.passed,
          failed: runComplete.failed_tests ?? counts?.failed,
          failed_tests: failedTests,
          check: `npx vent-hq status ${runId} --json`,
        },
      }) + "\n",
    );
    return;
  }

  // TTY: list failed tests with details
  const failures = testResults.filter((e) => {
    const meta = e.metadata_json ?? {};
    const r = meta.result as FormattedConversationResult | undefined;
    const status = r?.status ?? (meta.status as string);
    return status && status !== "completed" && status !== "pass";
  });

  if (failures.length > 0) {
    process.stdout.write("\n" + bold("Failed tests:") + "\n");
    for (const event of failures) {
      const meta = event.metadata_json ?? {};
      const r = meta.result as FormattedConversationResult | undefined;
      const name = r?.name ?? (meta.test_name as string) ?? "test";
      const durationMs = r?.duration_ms ?? (meta.duration_ms as number | undefined);
      const duration = durationMs != null ? (durationMs / 1000).toFixed(1) + "s" : "—";
      const parts = [red("✘"), bold(name), dim(duration)];
      if (r?.behavior?.intent_accuracy) {
        parts.push(`intent: ${r.behavior.intent_accuracy.score}`);
      }
      process.stdout.write("  " + parts.join("  ") + "\n");
    }
  }

  process.stderr.write(dim(`Full details: vent status ${runId} --json`) + "\n");
}

export function printError(message: string): void {
  const line = red(bold("error")) + ` ${message}\n`;
  process.stderr.write(line);
  // Also write to stdout so coding agents (which may only capture stdout) see errors
  if (!isTTY) {
    process.stdout.write(line);
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
