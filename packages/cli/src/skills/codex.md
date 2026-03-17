# Vent — Voice Agent Testing

Test voice agents from the terminal. Tests run in the cloud (30-120s).

## When to Test

- After modifying voice agent code (system prompt, tools, handlers): ALWAYS run tests
- After changing audio/telephony config: run tests
- Before marking a task complete that touches agent behavior: run tests

## Commands

| Command | Purpose |
|---------|---------|
| `npx vent-hq run -f .vent/suite.json --list` | List test names from suite |
| `npx vent-hq run -f .vent/suite.json --test <name>` | Run a single test by name |
| `npx vent-hq run --config '{...}'` | Run from inline JSON (one-off, no file needed) |
| `npx vent-hq status <run-id> --json` | Get full results for a completed run |
| `npx vent-hq docs` | Print full config schema reference |

## Workflow

1. Read the voice agent's codebase — understand its system prompt, tools, intents, and domain.
2. Run `npx vent-hq docs` to see the full config schema (first time only).
3. Create `.vent/suite.json` with tests tailored to the agent's actual behavior.
4. List tests: `npx vent-hq run -f .vent/suite.json --list`
5. Run each test individually as a separate parallel command:
   `npx vent-hq run -f .vent/suite.json --test <name>`
6. After code changes, re-run the same way.

## Critical Rules

1. **One test per command** — Always use `--test <name>`. Never run the full suite in one command.
2. **Run tests in parallel** — Each test is a separate shell command, run them all at once.

## Connection

- **Local agents**: set `start_command` — Vent starts the agent automatically
- **Deployed agents**: set `agent_url` — compatible with `--submit`

## Exit Codes

0=pass, 1=fail, 2=error
