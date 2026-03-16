import { parseArgs } from "node:util";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { loginCommand } from "./commands/login.js";
import { initCommand } from "./commands/init.js";
import { docsCommand } from "./commands/docs.js";
import { printError } from "./lib/output.js";

const USAGE = `Usage: vent <command> [options]

Commands:
  init      Set up Vent (auth + skill files + test scaffold)
  run       Run voice tests
  status    Check status of a previous run
  login     Save API key (for CI/scripts)
  docs      Print full config schema reference

Options:
  --help    Show help
  --version Show version

Run 'vent <command> --help' for command-specific help.`;

const RUN_USAGE = `Usage: vent run [options]

Options:
  --config, -c   Test config as JSON string
  --file, -f     Path to config JSON file
  --api-key      API key (overrides env/credentials)
  --json         Output NDJSON instead of colored text
  --submit       Submit and return immediately (print run_id, don't wait for results)`;

const STATUS_USAGE = `Usage: vent status <run-id> [options]

Options:
  --api-key      API key (overrides env/credentials)
  --json         Output raw JSON
  --stream       Stream live results instead of fetching current state`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write("vent 0.1.0\n");
    process.exit(0);
  }

  // Remove the command name for parseArgs
  const commandArgs = args.slice(1);

  let exitCode: number;

  switch (command) {
    case "init": {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          "api-key": { type: "string" },
        },
        strict: true,
      });
      exitCode = await initCommand({ apiKey: values["api-key"] });
      break;
    }

    case "run": {
      if (commandArgs.includes("--help")) {
        process.stdout.write(RUN_USAGE + "\n");
        process.exit(0);
      }
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          config: { type: "string", short: "c" },
          file: { type: "string", short: "f" },
          "api-key": { type: "string" },
          json: { type: "boolean", default: false },
          submit: { type: "boolean", default: false },
          "no-stream": { type: "boolean", default: false },
        },
        strict: true,
      });
      exitCode = await runCommand({
        config: values.config,
        file: values.file,
        apiKey: values["api-key"],
        json: values.json!,
        submit: values.submit! || values["no-stream"]!,
      });
      break;
    }

    case "status": {
      if (commandArgs.includes("--help") || commandArgs.length === 0) {
        process.stdout.write(STATUS_USAGE + "\n");
        process.exit(0);
      }
      const runId = commandArgs[0]!;
      const { values } = parseArgs({
        args: commandArgs.slice(1),
        options: {
          "api-key": { type: "string" },
          json: { type: "boolean", default: false },
          stream: { type: "boolean", default: false },
        },
        strict: true,
      });
      exitCode = await statusCommand({
        runId,
        apiKey: values["api-key"],
        json: values.json!,
        stream: values.stream!,
      });
      break;
    }

    case "login": {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          "api-key": { type: "string" },
        },
        strict: true,
      });
      exitCode = await loginCommand({ apiKey: values["api-key"] });
      break;
    }

    case "docs": {
      exitCode = await docsCommand();
      break;
    }

    default:
      printError(`Unknown command: ${command}`);
      process.stdout.write(USAGE + "\n");
      exitCode = 2;
  }

  process.exit(exitCode);
}

main().catch((err) => {
  printError((err as Error).message);
  process.exit(2);
});
