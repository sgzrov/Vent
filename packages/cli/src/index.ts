import { parseArgs } from "node:util";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { initCommand } from "./commands/init.js";
import { printError } from "./lib/output.js";
import { loadDotenv } from "./lib/dotenv.js";

const USAGE = `Usage: vent-hq <command> [options]

Commands:
  init         Set up Vent (auth + skill files + test scaffold)
  run          Run voice tests
  status       Check status of a previous run
  login        Save API key (for re-auth or CI/scripts)
  logout       Remove saved credentials
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
  --submit       Submit and return immediately (print run_id, don't wait for results)
  --verbose      Show debug logs (SSE, relay, internal events)`;

const STATUS_USAGE = `Usage: vent-hq status <run-id> [options]

Options:
  --api-key      API key (overrides env/credentials)
  --json         Output raw JSON
  --stream       Stream live results instead of fetching current state`;

async function main(): Promise<number> {
  loadDotenv();

  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    const pkg = await import("../package.json", { with: { type: "json" } });
    console.log(`vent-hq ${pkg.default.version}`);
    return 0;
  }

  // Remove the command name for parseArgs
  const commandArgs = args.slice(1);

  switch (command) {
    case "init": {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          "api-key": { type: "string" },
        },
        strict: true,
      });
      return initCommand({ apiKey: values["api-key"] });
    }

    case "run": {
      if (commandArgs.includes("--help")) {
        console.log(RUN_USAGE);
        return 0;
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
          verbose: { type: "boolean", default: false },
        },
        strict: true,
      });

      // --list: print test names and exit
      if (values.list) {
        let config: { conversation_tests?: Array<{ name?: string }>; red_team_tests?: Array<{ name?: string }> };
        try {
          if (values.file) {
            const fs = await import("node:fs/promises");
            const raw = await fs.readFile(values.file, "utf-8");
            config = JSON.parse(raw);
          } else if (values.config) {
            config = JSON.parse(values.config);
          } else {
            printError("--list requires --config or --file.");
            return 2;
          }
        } catch (err) {
          printError(`Invalid config JSON: ${(err as Error).message}`);
          return 2;
        }
        const convTests = config!.conversation_tests ?? [];
        for (let i = 0; i < convTests.length; i++) {
          console.log(convTests[i]!.name ?? `test-${i}`);
        }
        const redTests = config!.red_team_tests ?? [];
        for (let i = 0; i < redTests.length; i++) {
          console.log(redTests[i]!.name ?? `red-${i}`);
        }
        return 0;
      }

      return runCommand({
        config: values.config,
        file: values.file,
        test: values.test,
        apiKey: values["api-key"],
        json: values.json!,
        submit: values.submit! || values["no-stream"]!,
        verbose: values.verbose!,
      });
    }

    case "status": {
      if (commandArgs.includes("--help") || commandArgs.length === 0) {
        console.log(STATUS_USAGE);
        return 0;
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
      return statusCommand({
        runId,
        apiKey: values["api-key"],
        json: values.json!,
        stream: values.stream!,
      });
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
      return loginCommand({ apiKey: values["api-key"], status: values.status! });
    }

    case "logout": {
      return logoutCommand();
    }

    default:
      printError(`Unknown command: ${command}`);
      console.log(USAGE);
      return 2;
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  printError((err as Error).message);
  process.exitCode = 2;
});
