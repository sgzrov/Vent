# Vent

CI/CD testing for voice AI agents. Test latency, barge-in handling, echo detection, conversation quality, and tool calls — all from your coding agent via the Vent CLI.

## Quick Setup

```bash
npx vent init
```

This will:
1. Save your Vent access token (prompts if not set)
2. Install skill files for detected editors (Claude Code, Cursor)
3. Scaffold `.vent/suite.json` with a starter test config

## Commands

| Command | Purpose |
|---------|---------|
| `vent init` | Set up Vent in your project (auth + skill files + test scaffold) |
| `vent run -f .vent/suite.json` | Run tests, stream results |
| `vent run -f .vent/suite.json --submit` | Submit tests, return immediately with run_id |
| `vent status <run-id> --json` | Check results for a previous run |
| `vent login` | Save Vent access token (for CI/scripts) |
| `vent docs` | Print full config schema reference |

## What You Can Test

- **Conversation tests** — multi-turn scenarios with configurable personas, LLM-judged pass/fail evaluations, behavioral scoring (quality, empathy, safety)
- **Tool call testing** — verify your agent calls the right tools with correct arguments
- **Load testing** — ramp, spike, sustained, and soak patterns with auto-detected breaking points
- **Audio analysis** — echo detection, latency measurement, barge-in handling, silence detection

Supports 6 adapters: WebSocket (`websocket`), LiveKit/WebRTC (`livekit`), Vapi, Retell, ElevenLabs, and Bland.

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
      "caller_prompt": "You are Maria, calling to reschedule her dentist appointment from Thursday to next Tuesday.",
      "max_turns": 8
    }
  ]
}
```

Run `vent docs` for the full schema — includes all adapter configs, persona controls, audio actions, load testing, and more.

## Platform Credentials

For remote adapters (`vapi`, `retell`, `elevenlabs`, `bland`, `livekit`), keep provider credentials in `.env`, `.env.local`, or shell env and run `vent run` normally. The CLI resolves those values locally, auto-registers or updates a saved platform connection on the Vent API, and submits the run by connection ID so raw provider secrets do not get stored with the run or queued job payload.

Local relay runs (`start_command`) and hosted `agent_url` runs do not use saved platform connections. Only provider-backed platform adapters do.

When you do use saved platform connections, the API and worker must both have `PLATFORM_CONNECTIONS_MASTER_KEY` set to the same 32-byte key material (64 hex chars, base64, or a 32-byte UTF-8 string). That key is used to encrypt saved platform secrets at rest and decrypt them just before execution.

## Production Migrations

Production database migrations run inside Fly as part of the API deploy release step.

- `pnpm deploy:api` builds the API image and Fly runs `pnpm --filter @vent/db migrate` in a temporary release Machine before updating API Machines.
- `pnpm deploy:all` deploys the API first so schema migrations land before worker rollout.
- The release Machine uses the API app's Fly network and secrets, so `vent-db.flycast` works there without any laptop proxying.

## Exit Codes

0=pass, 1=fail, 2=error

## License

MIT
