---
name: vent
description: Voice agent testing — run tests, stream results
allowed-tools: Bash(vent *)
---

# Vent — Voice Agent Testing

Run voice tests from the terminal. Background-safe — run with & and check output when done.

## Commands
- `vent run --config '{...}'` — Run tests, stream results
- `vent run -f .vent/suite.json` — Run from config file
- `vent status <run-id>` — Check a previous run
- `vent status <run-id> --stream` — Stream live results
- `vent docs` — Full config schema reference

## Workflow
1. Check if `.vent/suite.json` exists. If not, run `vent docs` for the schema and create one.
2. Run `vent run -f .vent/suite.json` in background.
3. When done, read output. Correlate failures with the codebase and fix.

## Connection
- Local agents: set `start_command` — Vent starts the agent automatically via relay
- Deployed agents: set `agent_url` instead
- Do NOT start the agent yourself when using `start_command`

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

## Output
- TTY: colored one-liners per test (`✔ test-name  23.4s  intent: 0.95  p50: 420ms`)
- Non-TTY/`--json`: NDJSON events
- Exit codes: 0=pass, 1=fail, 2=error

## API Keys
Run `vent login` or set `VENT_API_KEY` env var.
Vent provides DEEPGRAM_API_KEY and ANTHROPIC_API_KEY automatically.
