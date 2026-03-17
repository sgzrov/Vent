---
description: Vent — Voice agent testing. Run tests against your voice agent, get pass/fail results. Use when the user asks to test their voice agent or when you need to verify voice agent behavior after code changes.
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
| `npx vent-hq run -f .vent/suite.json --list` | List test names from suite |
| `npx vent-hq run -f .vent/suite.json --test <name>` | Run a single test by name |
| `npx vent-hq run -f .vent/suite.json --test <name> --submit` | Submit a single test, return immediately with run_id |
| `npx vent-hq run --config '{...}'` | Run from inline JSON (one-off, no file needed) |
| `npx vent-hq status <run-id> --json` | Check results (full JSON when complete) |
| `npx vent-hq docs` | Print full config schema reference |

## Critical Rules

1. **One test per command** — Always use `--test <name>` to run a single test. Never run the full suite in one command.
2. **This skill is auto-injected** — Everything you need is here. Do NOT re-read this file or run `npx vent-hq docs` unless you're creating a suite for the first time.
3. **Always analyze results** — After tests complete, read every output, identify failures, correlate with the codebase, and fix.

## Workflow

### First time: create the test suite

1. Read the voice agent's codebase — understand its system prompt, tools, intents, and domain.
2. Run `npx vent-hq docs` to see the full config schema (first time only).
3. Create `.vent/suite.json` with tests tailored to the agent's actual behavior:
   - Name tests after specific flows (e.g., `"reschedule-appointment"`, not `"test-1"`)
   - Write `caller_prompt` as a realistic persona with a specific goal, based on the agent's domain
   - Set `max_turns` based on the flow complexity (simple FAQ: 4-6, booking: 8-12, complex: 12-20)
   - Add red team tests relevant to the domain (e.g., banking → KYC bypass, healthcare → HIPAA extraction)

### Subsequent runs — reuse the existing suite

`.vent/suite.json` already exists? Just re-run it. No need to recreate.

### Deployed agents (agent_url) — submit + poll per test

1. List tests: `npx vent-hq run -f .vent/suite.json --list`
2. Submit each test individually:
   ```
   npx vent-hq run -f .vent/suite.json --test greeting-and-hours --submit
   npx vent-hq run -f .vent/suite.json --test book-cleaning --submit
   npx vent-hq run -f .vent/suite.json --test red-team-prompt-extraction --submit
   ```
3. Collect all run_ids, then poll each:
   `npx vent-hq status <run-id> --json`
4. If status is `"running"`, wait 30 seconds and check again.
5. When complete, correlate any failures with the codebase and fix.

### Local agents (start_command) — run each test sequentially

When config uses `start_command`, the CLI manages the agent process:

1. List tests: `npx vent-hq run -f .vent/suite.json --list`
2. Run each test one at a time:
   `npx vent-hq run -f .vent/suite.json --test <name>`
3. Read results after each, fix failures.

### Quick one-off test

For a single test without creating a file:

```bash
npx vent-hq run --config '{"connection":{"adapter":"websocket","start_command":"npm run start","agent_port":3001},"conversation_tests":[{"name":"quick-check","caller_prompt":"You are a customer calling to ask about business hours.","max_turns":4}]}'
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

Run `npx vent-hq docs` for the full schema — includes persona controls, audio stress tests, load testing, and all adapter configs.

## Exit Codes

0=pass, 1=fail, 2=error

## API Keys

Set `VENT_API_KEY` env var or run `npx vent-hq login`.
