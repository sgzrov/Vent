# Vent

CI/CD testing for voice AI agents. Test latency, barge-in handling, echo detection, conversation quality, and tool calls — all from your coding agent via the Vent CLI.

## Quick Setup

```bash
npx vent init
```

This will:
1. Save your API key (prompts if not set)
2. Install skill files for detected editors (Claude Code, Cursor)
3. Scaffold `.vent/suite.json` with a starter test config

## Commands

| Command | Purpose |
|---------|---------|
| `vent init` | Set up Vent in your project (auth + skill files + test scaffold) |
| `vent run -f .vent/suite.json` | Run tests, stream results |
| `vent run -f .vent/suite.json --submit` | Submit tests, return immediately with run_id |
| `vent status <run-id> --json` | Check results for a previous run |
| `vent login` | Save API key (for CI/scripts) |
| `vent docs` | Print full config schema reference |

## What You Can Test

- **Conversation tests** — multi-turn scenarios with configurable personas, LLM-judged pass/fail evaluations, behavioral scoring (quality, empathy, safety)
- **Tool call testing** — verify your agent calls the right tools with correct arguments
- **Load testing** — ramp, spike, sustained, and soak patterns with auto-detected breaking points
- **Audio analysis** — echo detection, latency measurement, barge-in handling, silence detection

Supports 7 adapters: WebSocket (`websocket`), SIP/phone (`sip`), WebRTC/LiveKit (`webrtc`), Vapi, Retell, ElevenLabs, and Bland.

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

## Exit Codes

0=pass, 1=fail, 2=error

## License

MIT
