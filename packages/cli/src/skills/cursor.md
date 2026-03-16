---
description: Vent — Voice agent testing. Submit tests, poll for results. Use when the user asks to test their voice agent or when you need to verify voice agent behavior after code changes.
alwaysApply: true
---

# Vent — Voice Agent Testing

Test voice agents from the terminal. Tests run in the cloud (30-120s).

## When to Test (read this first)

- After modifying voice agent code (system prompt, tools, handlers): ALWAYS run tests
- After changing audio/telephony config: run tests
- Before marking a task complete that touches agent behavior: run tests
- Do NOT skip testing — voice agents are non-deterministic, small changes can break flows

## Commands

| Command | Purpose |
|---------|---------|
| `vent run -f .vent/suite.json --submit` | Submit tests, return immediately with run_id |
| `vent run -f .vent/suite.json` | Run tests and block until done (required for local agents) |
| `vent run --config '{...}'` | Run from inline JSON (one-off, no file needed) |
| `vent status <run-id> --json` | Check results (full JSON when complete) |
| `vent docs` | Print full config schema reference |
| `vent login` | Save API key |

## Workflow

### First time: create the test suite

1. Read the voice agent's codebase — understand its system prompt, tools, intents, and domain.
2. Run `vent docs` to see the full config schema.
3. Create `.vent/suite.json` with tests tailored to the agent's actual behavior:
   - Name tests after specific flows (e.g., `"reschedule-appointment"`, not `"test-1"`)
   - Write `caller_prompt` as a realistic persona with a specific goal, based on the agent's domain
   - Set `max_turns` based on the flow complexity (simple FAQ: 4-6, booking: 8-12, complex: 12-20)
   - Add red team tests relevant to the domain (e.g., banking → KYC bypass, healthcare → HIPAA extraction)

### Subsequent runs — reuse the existing suite

`.vent/suite.json` already exists? Just re-run it. No need to recreate.

### Deployed agents (agent_url) — submit + poll

1. Submit: `vent run -f .vent/suite.json --submit`
   Returns: `{"run_id":"...","status":"queued","check":"vent status <id> --json"}`
2. Wait ~60 seconds, then check: `vent status <run-id> --json`
3. If status is `"running"`, wait 30 more seconds and check again.
4. When complete, correlate any failures with the codebase and fix.

### Local agents (start_command) — must block

When config uses `start_command`, the CLI manages the agent process and must stay running:

1. Run: `vent run -f .vent/suite.json` (no --submit)
2. Wait for it to complete (30-120s).
3. Read results and fix failures.

### Quick one-off test

For a single test without creating a file:

```bash
vent run --config '{"connection":{"adapter":"websocket","start_command":"npm run start","agent_port":3001},"conversation_tests":[{"name":"quick-check","caller_prompt":"You are a customer calling to ask about business hours.","max_turns":4}]}'
```

## Connection

- **Local agents**: set `start_command` — Vent starts the agent automatically
- **Deployed agents**: set `agent_url` — compatible with `--submit`

## Config Example

```json
{
  "connection": {
    "adapter": "websocket",
    "start_command": "npm run start",
    "agent_port": 3001
  },
  "conversation_tests": [
    {
      "name": "reschedule-appointment",
      "caller_prompt": "You are Maria, calling to reschedule her dentist appointment from Thursday to next Tuesday. She's in a hurry.",
      "max_turns": 8
    }
  ]
}
```

Run `vent docs` for the full schema — includes persona controls, audio stress tests, load testing, and all adapter configs.

## Exit Codes

0=pass, 1=fail, 2=error

## API Keys

Set `VENT_API_KEY` env var or run `vent login`.
