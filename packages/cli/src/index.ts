import { parseArgs } from "node:util";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { initCommand } from "./commands/init.js";
import { docsCommand } from "./commands/docs.js";
import { printError } from "./lib/output.js";

const USAGE = `Usage: vent-hq <command> [options]

Commands:
  init      Set up Vent (auth + skill files + test scaffold)
  run       Run voice tests
  status    Check status of a previous run
  login     Save API key (for re-auth or CI/scripts)
  logout    Remove saved credentials
  docs      Print full config schema reference

Options:
  --help    Show help
  --version Show version

Run 'npx vent-hq <command> --help' for command-specific help.`;

const RUN_USAGE = `Usage: vent-hq run [options]

Options:
  --config, -c   Test config as JSON string
  --file, -f     Path to config JSON file
  --test, -t     Run a single test by name (from suite file)
  --list         List test names from suite file
  --api-key      API key (overrides env/credentials)
  --json         Output NDJSON instead of colored text
  --submit       Submit and return immediately (print run_id, don't wait for results)`;

const STATUS_USAGE = `Usage: vent-hq status <run-id> [options]

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
    const pkg = await import("../package.json", { with: { type: "json" } });
    process.stdout.write(`vent-hq ${pkg.default.version}\n`);
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
          test: { type: "string", short: "t" },
          list: { type: "boolean", default: false },
          "api-key": { type: "string" },
          json: { type: "boolean", default: false },
          submit: { type: "boolean", default: false },
          "no-stream": { type: "boolean", default: false },
        },
        strict: true,
      });

      // --list: print test names and exit
      if (values.list) {
        let config: { conversation_tests?: Array<{ name?: string }> };
        try {
          if (values.file) {
            const fs = await import("node:fs/promises");
            const raw = await fs.readFile(values.file, "utf-8");
            config = JSON.parse(raw);
          } else if (values.config) {
            config = JSON.parse(values.config);
          } else {
            printError("--list requires --config or --file.");
            process.exit(2);
          }
        } catch (err) {
          printError(`Invalid config JSON: ${(err as Error).message}`);
          process.exit(2);
        }
        const tests = config!.conversation_tests ?? [];
        for (let i = 0; i < tests.length; i++) {
          process.stdout.write((tests[i]!.name ?? `test-${i}`) + "\n");
        }
        process.exit(0);
      }

      exitCode = await runCommand({
        config: values.config,
        file: values.file,
        test: values.test,
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
          status: { type: "boolean", default: false },
        },
        strict: true,
      });
      exitCode = await loginCommand({ apiKey: values["api-key"], status: values.status! });
      break;
    }

    case "logout": {
      exitCode = await logoutCommand();
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
