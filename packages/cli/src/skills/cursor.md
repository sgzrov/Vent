---
description: Vent — Voice agent testing CLI. Run tests, stream results.
globs:
alwaysApply: true
---

# Vent — Voice Agent Testing

Run voice tests from the terminal using the `vent` CLI.

## Commands
- `vent run --config '{...}'` — Run tests, stream results
- `vent run -f .vent/suite.json` — Run from config file
- `vent status <run-id>` — Check a previous run
- `vent docs` — Full config schema reference

## Workflow
1. Check if `.vent/suite.json` exists. If not, run `vent docs` for the schema and create one.
2. Run `vent run -f .vent/suite.json`.
3. Read output. Correlate failures with the codebase and fix.

## Connection
- Local agents: set `start_command` — Vent starts the agent automatically
- Deployed agents: set `agent_url` instead

## Config Shape
```json
{
  "connection": {
    "adapter": "websocket",
    "start_command": "npm run start",
    "agent_port": 3001
  },
  "conversation_tests": [
    {
      "name": "happy-path",
      "caller_prompt": "You are Maria, calling to reschedule...",
      "max_turns": 8
    }
  ]
}
```

## Exit Codes
0=pass, 1=fail, 2=error

## API Keys
Set `VENT_API_KEY` env var or run `vent login`.
