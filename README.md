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
| `vent run -f .vent/suite.json` | Run a call, block until results |
| `vent run -f .vent/suite.json --call <name>` | Run a specific named call |
| `vent status <run-id>` | Check results of a previous run |
| `vent login` | Authenticate via browser |

## What You Can Test

- **Conversation tests** — multi-turn scenarios with configurable personas, LLM-judged pass/fail evaluations, behavioral scoring (quality, empathy, safety)
- **Tool call testing** — verify your agent calls the right tools with correct arguments
- **Load testing** — ramp, spike, sustained, and soak patterns with auto-detected breaking points
- **Audio analysis** — echo detection, latency measurement, barge-in handling, silence detection

## Adapters

Vent supports 6 adapters. Each adapter determines how Vent connects to your agent and what data it can collect.

| Adapter | Local dev | Custom endpoint | Platform-hosted | Observability |
|---------|-----------|-----------------|-----------------|---------------|
| `websocket` | Via relay | Via `agent_url` | — | Agent emits `vent:*` events |
| `livekit` | Agent runs locally in dev mode, connects to LiveKit server | Any LiveKit server URL | LiveKit Cloud | Automatic via Agents SDK (`lk.agent.state`, `lk.transcription`) + `vent:*` enrichment |
| `vapi` | — | — | Vapi only | Automatic via platform API + WebSocket events |
| `retell` | — | — | Retell only | Automatic via platform API + WebRTC DataChannel |
| `elevenlabs` | — | — | ElevenLabs only | Automatic via platform API + WebRTC DataChannel |
| `bland` | — | — | Bland only | Automatic via platform API + HTTP webhooks |

**Local dev** — test an agent running on your machine. `websocket` uses Vent's relay to bridge the worker to your local agent. `livekit` agents run locally in [dev mode](https://docs.livekit.io/agents/server/startup-modes/) and connect to a LiveKit server; Vent joins the same room — no relay needed.

**Custom endpoint** — test an agent at a specific URL you control (e.g. a staging server). Only `websocket` and `livekit` support this.

**Platform-hosted** — test agents deployed on a voice AI platform. Vapi, Retell, ElevenLabs, and Bland agents always run on the platform's infrastructure. You configure the agent there, Vent calls it and observes the results.

**Observability** — platform adapters get component latency, tool calls, transcripts, cost, and metadata automatically. The `websocket` adapter gets the same data when the coding agent instruments the user's agent with `vent:*` events (documented in the SKILL file). The `livekit` adapter gets automatic observability from the Agents SDK plus optional `vent:*` enrichment via the `@vent-hq/livekit` helper.

> **LiveKit adapter requirement:** The `livekit` adapter requires agents built with the [LiveKit Agents SDK](https://docs.livekit.io/agents/). It depends on Agents SDK signals (`lk.agent.state`, `lk.transcription`) for readiness detection, turn timing, and component latency. Custom LiveKit participants not using the Agents SDK should use the `websocket` adapter with a relay instead.

## Result Normalization

Vent always emits one normalized conversation result shape on `stdout`.

Top-level result categories are:
- `transcript`
- `latency`
- `transcript_quality`
- `audio_analysis`
- `tool_calls`
- `component_latency`
- `call_metadata`
- `warnings`
- `audio_actions`
- `emotion`
- `debug` only when `--verbose` is used

Source-of-truth policy:
- Vent computes `transcript_quality`, `latency`, and `audio_analysis` itself from the captured call.
- Hosted adapters choose the best source per category, usually provider post-call artifacts for `tool_calls`, `call_metadata`, `transfers`, recordings, and provider transcripts.
- Realtime provider events are used as fallback or enrichment when post-call data is missing, delayed, weaker for that category, or provider-specific.
- `LiveKit` rich observability comes from the Vent helper running inside the agent runtime.
- `websocket`/custom agents are realtime-native and emit the same normalized categories through the Vent protocol.
- `recording_url` is provider-first with Vent fallback when a provider artifact is missing.

This keeps adapter-specific differences inside ingestion code while preserving one stable result schema for coding agents.

### Example Result

```json
{
  "name": "reschedule-appointment",
  "status": "completed",
  "caller_prompt": "You are Maria calling to reschedule her appointment.",
  "duration_ms": 48213,
  "error": null,
  "transcript": [
    { "role": "caller", "text": "Hi, I need to move my appointment to Friday." },
    { "role": "agent", "text": "Sure, I can help with that.", "ttfb_ms": 812, "ttfw_ms": 1094, "audio_duration_ms": 2410 }
  ],
  "latency": {
    "response_time_ms": 1094,
    "response_time_source": "ttfw",
    "p50_response_time_ms": 1094,
    "p95_response_time_ms": 1094,
    "first_response_time_ms": 1094,
    "total_silence_ms": 690,
    "mean_turn_gap_ms": 345
  },
  "transcript_quality": {
    "wer": 0.06,
    "repetition_score": 0.03,
    "reprompt_count": 0,
    "reprompt_rate": 0,
    "filler_word_rate": 0.01,
    "words_per_minute": 149,
    "vocabulary_diversity": 0.78
  },
  "audio_analysis": {
    "caller_talk_time_ms": 6420,
    "agent_talk_time_ms": 9030,
    "agent_speech_ratio": 0.93,
    "talk_ratio_vad": 0.42,
    "interruption_rate": 0,
    "interruption_count": 0,
    "agent_overtalk_after_barge_in_ms": 0,
    "missed_response_windows": 0
  },
  "tool_calls": {
    "total": 2,
    "successful": 2,
    "failed": 0,
    "mean_latency_ms": 384,
    "names": ["calendar.lookup", "calendar.reschedule"],
    "observed": [
      {
        "name": "calendar.lookup",
        "arguments": { "date": "2026-04-10", "after": "14:00" },
        "result": { "slots": ["15:00", "16:30"] },
        "successful": true,
        "provider_tool_type": "mcp",
        "latency_ms": 301,
        "turn_index": 1
      }
    ]
  },
  "component_latency": {
    "mean_stt_ms": 152,
    "mean_llm_ms": 401,
    "mean_tts_ms": 233,
    "p95_stt_ms": 191,
    "p95_llm_ms": 588,
    "p95_tts_ms": 301,
    "mean_speech_duration_ms": 2524,
    "bottleneck": "llm"
  },
  "call_metadata": {
    "platform": "retell",
    "provider_call_id": "call_01JQXYZ123",
    "ended_reason": "call_ended",
    "duration_s": 48.2,
    "cost_usd": 0.18,
    "cost_breakdown": {
      "stt_usd": 0.01,
      "llm_usd": 0.09,
      "tts_usd": 0.03,
      "total_usd": 0.18
    },
    "recording_url": "https://artifacts.vent.dev/runs/run_123/recording.mp3",
    "recording_variants": {
      "multi_channel": "https://provider.example/recording-multichannel.wav"
    },
    "provider_debug_urls": {
      "public_log": "https://provider.example/public-log.txt"
    },
    "summary": "The caller successfully rescheduled the appointment.",
    "call_successful": true,
    "transfer_attempted": false,
    "transfer_completed": false
  },
  "warnings": [],
  "audio_actions": [],
  "emotion": null
}
```

## Config Example

```json
{
  "connection": {
    "adapter": "websocket",
    "start_command": "npm run start",
    "agent_port": 3001
  },
  "calls": {
    "reschedule-appointment": {
      "caller_prompt": "You are Maria, calling to reschedule her dentist appointment from Thursday to next Tuesday.",
      "max_turns": 8
    }
  }
}
```

One suite file per adapter. `connection` declared once, `calls` is a named map. Run `vent run -f suite.json --call reschedule-appointment`.

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

## Packages

| Package | Description |
|---------|-------------|
| [`@vent-hq/livekit`](packages/livekit/) | Helper for forwarding LiveKit Agents SDK observability into Vent |

## License

MIT
