import type { FormattedConversationResult, FormattedLoadTestResult } from "@vent/shared";
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

  switch (event.event_type) {
    case "test_completed":
      printTestResult(event.data);
      break;
    case "run_complete":
      printRunComplete(event.data);
      break;
    case "test_started":
      if (isTTY) {
        const name = (event.data as { test_name?: string }).test_name ?? "test";
        process.stderr.write(dim(`  ▸ ${name}…`) + "\n");
      }
      break;
    default:
      if (isTTY) {
        process.stderr.write(dim(`  [${event.event_type}]`) + "\n");
      }
  }
}

function printTestResult(data: Record<string, unknown>): void {
  const result = data.result as FormattedConversationResult | undefined;
  if (!result) return;

  const status = result.status === "completed" ? green("✔") : red("✘");
  const name = result.name ?? "test";
  const duration = (result.duration_ms / 1000).toFixed(1) + "s";

  const parts = [status, bold(name), dim(duration)];

  if (result.behavior?.intent_accuracy) {
    parts.push(`intent: ${result.behavior.intent_accuracy.score}`);
  }
  if (result.latency?.p50_ttfw_ms != null) {
    parts.push(`p50: ${result.latency.p50_ttfw_ms}ms`);
  }

  process.stdout.write(parts.join("  ") + "\n");
}

function printRunComplete(data: Record<string, unknown>): void {
  const status = data.status as string;
  const total = data.total_tests as number | undefined;
  const passed = data.passed_tests as number | undefined;
  const failed = data.failed_tests as number | undefined;

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
        const r = e.data.result as FormattedConversationResult | undefined;
        return r && r.status !== "completed";
      })
      .map((e) => {
        const r = e.data.result as FormattedConversationResult;
        return {
          name: r.name,
          status: r.status,
          duration_ms: r.duration_ms,
          intent_accuracy: r.behavior?.intent_accuracy?.score,
          p50_ttfw_ms: r.latency?.p50_ttfw_ms,
        };
      });

    process.stdout.write(
      JSON.stringify({
        event_type: "summary",
        data: {
          run_id: runId,
          status: runComplete.status,
          total: runComplete.total_tests,
          passed: runComplete.passed_tests,
          failed: runComplete.failed_tests,
          failed_tests: failedTests,
          check: `npx vent-hq status ${runId} --json`,
        },
      }) + "\n",
    );
    return;
  }

  // TTY: list failed tests with details
  const failures = testResults.filter((e) => {
    const r = e.data.result as FormattedConversationResult | undefined;
    return r && r.status !== "completed";
  });

  if (failures.length > 0) {
    process.stdout.write("\n" + bold("Failed tests:") + "\n");
    for (const event of failures) {
      const r = event.data.result as FormattedConversationResult;
      const name = r.name ?? "test";
      const duration = (r.duration_ms / 1000).toFixed(1) + "s";
      const parts = [red("✘"), bold(name), dim(duration)];
      if (r.behavior?.intent_accuracy) {
        parts.push(`intent: ${r.behavior.intent_accuracy.score}`);
      }
      process.stdout.write("  " + parts.join("  ") + "\n");
    }
  }

  process.stderr.write(dim(`Full details: vent status ${runId} --json`) + "\n");
}

export function printError(message: string): void {
  process.stderr.write(red(bold("error")) + ` ${message}\n`);
}

export function printInfo(message: string): void {
  if (isTTY) {
    process.stderr.write(blue("▸") + ` ${message}\n`);
  }
}

export function printSuccess(message: string): void {
  process.stderr.write(green("✔") + ` ${message}\n`);
}

export function printWarn(message: string): void {
  process.stderr.write(yellow("⚠") + ` ${message}\n`);
}
