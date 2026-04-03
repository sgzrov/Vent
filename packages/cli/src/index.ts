import { parseArgs } from "node:util";
import { runCommand } from "./commands/run.js";
import { agentStartCommand, agentStopCommand } from "./commands/agent.js";
import { statusCommand } from "./commands/status.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { initCommand } from "./commands/init.js";
import { stopCommand } from "./commands/stop.js";
import { printError } from "./lib/output.js";
import { loadDotenv } from "./lib/dotenv.js";

const USAGE = `Usage: vent-hq <command> [options]

Commands:
  init         Set up Vent (auth + skill files + call scaffold)
  agent        Manage a shared local agent session
  run          Run voice calls
  stop         Cancel a queued or running call
  status       Check status of a previous run
  login        Save Vent access token (for re-auth or CI/scripts)
  logout       Remove saved credentials
Options:
  --help    Show help
  --version Show version

Run 'npx vent-hq <command> --help' for command-specific help.`;

const RUN_USAGE = `Usage: vent-hq run [options]

Options:
  --config, -c   Call config as JSON string
  --file, -f     Path to config JSON file
  --call, -t     Run a single call by name (from suite file)
  --session, -s  Reuse an existing local agent session
  --list         List call names from suite file
  --access-token Vent access token (overrides env/credentials)
  --json         Output NDJSON instead of colored text
  --submit       Submit and return immediately (print run_id, don't wait for results)
  --verbose      Show debug logs (SSE, relay, internal events)`;

const AGENT_USAGE = `Usage: vent-hq agent <command> [options]

Commands:
  start         Start a shared local agent session and keep the relay open
  stop          Close a shared local agent session

Start options:
  --config, -c   Config JSON string with a connection block
  --file, -f     Path to config JSON file
  --access-token Vent access token (overrides env/credentials)
  --json         Output session info as JSON
  --verbose      Show relay debug logs

Stop options:
  vent-hq agent stop <session-id> [--access-token <token>]`;

const STATUS_USAGE = `Usage: vent-hq status <run-id> [options]

Options:
  --access-token Vent access token (overrides env/credentials)
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
          "access-token": { type: "string" },
        },
        strict: true,
      });
      return initCommand({ accessToken: values["access-token"] });
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
          call: { type: "string", short: "n" },
          session: { type: "string", short: "s" },
          list: { type: "boolean", default: false },
          "access-token": { type: "string" },
          json: { type: "boolean", default: false },
          submit: { type: "boolean", default: false },
          "no-stream": { type: "boolean", default: false },
          verbose: { type: "boolean", default: false },
        },
        strict: true,
      });

      // --list: print call names and exit
      if (values.list) {
        let config: { conversation_calls?: Array<{ name?: string }> };
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
        const convCalls = config!.conversation_calls ?? [];
        for (let i = 0; i < convCalls.length; i++) {
          console.log(convCalls[i]!.name ?? `call-${i}`);
        }
        return 0;
      }

      return runCommand({
        config: values.config,
        file: values.file,
        call: values.call,
        session: values.session,
        accessToken: values["access-token"],
        json: values.json!,
        submit: values.submit! || values["no-stream"]!,
        verbose: values.verbose!,
      });
    }

    case "agent": {
      const subcommand = commandArgs[0];
      if (!subcommand || subcommand === "--help" || subcommand === "-h") {
        console.log(AGENT_USAGE);
        return 0;
      }

      if (subcommand === "start") {
        const { values } = parseArgs({
          args: commandArgs.slice(1),
          options: {
            config: { type: "string", short: "c" },
            file: { type: "string", short: "f" },
            "access-token": { type: "string" },
            json: { type: "boolean", default: false },
            verbose: { type: "boolean", default: false },
          },
          strict: true,
        });
        return agentStartCommand({
          config: values.config,
          file: values.file,
          accessToken: values["access-token"],
          json: values.json!,
          verbose: values.verbose!,
        });
      }

      if (subcommand === "stop") {
        const sessionId = commandArgs[1];
        if (!sessionId) {
          console.log(AGENT_USAGE);
          return 2;
        }
        const { values } = parseArgs({
          args: commandArgs.slice(2),
          options: {
            "access-token": { type: "string" },
          },
          strict: true,
        });
        return agentStopCommand({
          sessionId,
          accessToken: values["access-token"],
        });
      }

      printError(`Unknown agent subcommand: ${subcommand}`);
      console.log(AGENT_USAGE);
      return 2;
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
          "access-token": { type: "string" },
          json: { type: "boolean", default: false },
          stream: { type: "boolean", default: false },
        },
        strict: true,
      });
      return statusCommand({
        runId,
        accessToken: values["access-token"],
        json: values.json!,
        stream: values.stream!,
      });
    }

    case "stop": {
      const runId = commandArgs[0];
      if (!runId || commandArgs.includes("--help")) {
        console.log("Usage: vent-hq stop <run-id> [--access-token <token>]");
        return runId ? 0 : 2;
      }
      const { values: stopValues } = parseArgs({
        args: commandArgs.slice(1),
        options: { "access-token": { type: "string" } },
        strict: true,
      });
      return stopCommand({ runId, accessToken: stopValues["access-token"] });
    }

    case "login": {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          "access-token": { type: "string" },
          status: { type: "boolean", default: false },
        },
        strict: true,
      });
      return loginCommand({ accessToken: values["access-token"], status: values.status! });
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
