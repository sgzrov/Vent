# Vent — Voice Agent Calls

Call voice agents from the terminal. Calls run in the cloud (30-120s).

## When to Call

- After modifying voice agent code (system prompt, tools, handlers): ALWAYS run calls
- After changing audio config: run calls
- Before marking a task complete that touches agent behavior: run calls

## Setup (if no Vent access token)

If `~/.vent/credentials` does not exist and `VENT_ACCESS_TOKEN` is not set:

```bash
npx vent-hq init
```

One command. No email, no browser, no human interaction needed. You get 10 free runs instantly.

## Commands

| Command | Purpose |
|---------|---------|
| `npx vent-hq init` | First-time setup (creates account + installs skills) |
| `npx vent-hq agent start -f .vent/suite.<adapter>.json` | Start one shared local agent session (required for `start_command`) |
| `npx vent-hq agent stop <session-id>` | Close a shared local agent session |
| `npx vent-hq run -f .vent/suite.<adapter>.json --list` | List call names from suite |
| `npx vent-hq run -f .vent/suite.<adapter>.json --call <name>` | Run a single call by name |
| `npx vent-hq run --config '{...}'` | Run from inline JSON (one-off, no file needed) |
| `npx vent-hq run -f .vent/suite.<adapter>.json --call <name> --submit` | Submit remote call, return immediately with run_id (hosted custom agents or platform-direct adapters) |
| `npx vent-hq stop <run-id>` | Cancel a queued or running call |
| `npx vent-hq status <run-id> --json` | Get full results for a completed run |


## Workflow

1. Read the voice agent's codebase — understand its system prompt, tools, intents, and domain.
2. Read the config schema below for all available fields.
3. Create the suite file in `.vent/` using the naming convention: `.vent/suite.<adapter>.json` (e.g., `.vent/suite.vapi.json`, `.vent/suite.websocket.json`, `.vent/suite.retell.json`). This prevents confusion when multiple adapters are tested in the same project.
4. List calls: `npx vent-hq run -f .vent/suite.<adapter>.json --list`
5. Run each call individually as a separate parallel command:
   `npx vent-hq run -f .vent/suite.<adapter>.json --call <name>`
   If the suite uses `start_command`, first start a shared relay with `npx vent-hq agent start -f .vent/suite.<adapter>.json`, then add `--session <session-id>` to every `vent-hq run` call.
6. After results return, **compare with previous run** — Vent saves full result JSON to `.vent/runs/` after every run. Read the second-most-recent JSON in `.vent/runs/` and compare against the current run: status flips (pass→fail), TTFW p50/p95 changes >20%, tool call count drops, cost increases >30%, transcript divergence. Correlate with `git diff` between the two runs' git SHAs. Skip if no previous run exists.
7. After code changes, re-run the same way.

### Multiple suite files

If `.vent/` contains more than one suite file, **always check which adapter each suite uses before running**. Read the `connection.adapter` field in each file. Never run a suite intended for a different adapter — results will be meaningless or fail. When reporting results, always state which suite file produced them (e.g., "Results from `.vent/suite.vapi.json`:").

## Critical Rules

1. **One call per command** — Always use `--call <name>`. Never run the full suite in one command.
2. **Run calls in parallel with 5min timeout** — Each call is a separate shell command, run them all at once. Set a 300-second (5 min) timeout on each — calls can take up to 5 minutes.
3. **Handle backgrounded commands** — If a call command gets moved to background by the system, wait for it to complete before proceeding. Never end your response without delivering call results.
4. **Output format** — In non-TTY mode (when run by an agent), every SSE event is written to stdout as a JSON line. Results are always in stdout.
5. **This skill is self-contained** — The full config schema is below.
6. **ENFORCE concurrency limits** — Before running ANY suite, count the total concurrent calls (number of calls × repeat). If this exceeds the platform's limit, REDUCE the call count or split into multiple runs. Default limits if unknown: LiveKit=5, Vapi=10, Bland=10. Calls that exceed the limit will hang forever waiting for agents that never connect. This is NOT optional.

## WebSocket Protocol (BYO agents)

When using `adapter: "websocket"`, Vent communicates with the agent over a single WebSocket connection:

- **Binary frames** → PCM audio (16-bit mono, configurable sample rate)
- **Text frames** → optional JSON events the agent can send for better test accuracy:

| Event | Format | Purpose |
|-------|--------|---------|
| `speech-update` | `{"type":"speech-update","status":"started"\|"stopped"}` | Enables platform-assisted turn detection (more accurate than VAD alone) |
| `tool_call` | `{"type":"tool_call","name":"...","arguments":{...},"result":...,"successful":bool,"duration_ms":number}` | Reports tool calls for observability |
| `vent:timing` | `{"type":"vent:timing","stt_ms":number,"llm_ms":number,"tts_ms":number}` | Reports component latency breakdown per turn |

Vent sends `{"type":"end-call"}` to the agent when the test is done.

All text frames are optional — audio-only agents work fine with VAD-based turn detection.

## Full Config Schema

- **HARD CONCURRENCY LIMITS — NEVER EXCEED** — Each call is a real concurrent call. If you create more calls than the platform allows, excess calls hang forever (agents never connect). Before running, count: total_concurrent = number_of_calls × max(repeat, 1). If total_concurrent > platform limit, REDUCE calls or split into sequential runs.
  | Platform | Default limit (assume if unknown) | Ask user for tier |
  |----------|----------------------------------|-------------------|
  | LiveKit | **5** | Build=5, Ship=20, Scale=50+ |
  | Vapi | **10** | Starter=10, Growth=50, Enterprise=100+ |
  | Bland | **3** (phone-based, 10s between calls) | Max 3 concurrent. Bland uses phone calls routed through one Twilio number — Bland drops calls when 4+ target the same number. Scaling beyond 3 requires a Twilio number pool (not yet implemented). |
  | ElevenLabs | **5** | Ask user |
  | Retell | **5** | Ask user |
  | websocket (custom) | No platform limit | — |
  If the existing suite file has more calls than the limit, run with `--call` to pick a subset, or split into multiple sequential runs. Do NOT just run the full suite and hope for the best.
- ALL calls MUST reference the agent's real context (system prompt, tools, knowledge base) from the codebase.

<vent_run>
{
  "connection": { ... },
  "conversation_calls": [{ ... }]
}
</vent_run>

<config_connection>
{
  "connection": {
    "adapter": "required -- websocket | livekit | vapi | retell | elevenlabs | bland",
    "start_command": "shell command to start agent (relay only, required for local)",
    "health_endpoint": "health check path after start_command (default: /health, relay only, required for local)",
    "agent_url": "hosted custom agent URL (wss:// or https://). Use for BYO hosted agents.",
    "agent_port": "local agent port (default: 3001, required for local)",
    "platform": "optional authoring convenience for platform-direct adapters only. The CLI resolves this locally, creates/updates a saved platform connection, and strips raw provider secrets before submit. Do not use for websocket start_command or agent_url runs."
  }
}

<credential_resolution>
IMPORTANT: How to handle platform credentials (API keys, secrets, agent IDs):

There are two product modes:
- `BYO agent runtime`: your agent owns its own provider credentials. This covers both `start_command` (local) and `agent_url` (hosted custom endpoint).
- `Platform-direct runtime`: Vent talks to `vapi`, `retell`, `elevenlabs`, `bland`, or `livekit` directly. This is the only mode that uses saved platform connections.

1. For `start_command` and `agent_url` runs, do NOT put Deepgram / ElevenLabs / OpenAI / other provider keys into Vent config unless the Vent adapter itself needs them. Those credentials belong to the user's local or hosted agent runtime.
2. For platform-direct adapters (`vapi`, `retell`, `elevenlabs`, `bland`, `livekit`), the CLI auto-resolves credentials from `.env.local`, `.env`, and the current shell env. If those env vars already exist, you can omit credential fields from the config JSON entirely.
3. If you include credential fields in the config, put the ACTUAL VALUE, NOT the env var name. WRONG: `"vapi_api_key": "VAPI_API_KEY"`. RIGHT: `"vapi_api_key": "sk-abc123..."` or omit the field.
4. The CLI uses the resolved provider config to create or update a saved platform connection server-side, then submits only `platform_connection_id`. Users should not manually author `platform_connection_id`.
5. To check whether credentials are already available, inspect `.env.local`, `.env`, and any relevant shell env visible to the CLI process.

Auto-resolved env vars per platform:
| Platform | Config field | Env var (auto-resolved from `.env.local`, `.env`, or shell env) |
|----------|-------------|-----------------------------------|
| Vapi | vapi_api_key | VAPI_API_KEY |
| Vapi | vapi_assistant_id | VAPI_ASSISTANT_ID |
| Bland | bland_api_key | BLAND_API_KEY |
| Bland | bland_pathway_id | BLAND_PATHWAY_ID |
| LiveKit | livekit_api_key | LIVEKIT_API_KEY |
| LiveKit | livekit_api_secret | LIVEKIT_API_SECRET |
| LiveKit | livekit_url | LIVEKIT_URL |
| Retell | retell_api_key | RETELL_API_KEY |
| Retell | retell_agent_id | RETELL_AGENT_ID |
| ElevenLabs | elevenlabs_api_key | ELEVENLABS_API_KEY |
| ElevenLabs | elevenlabs_agent_id | ELEVENLABS_AGENT_ID |

The CLI strips raw platform secrets before `/runs/submit`. Platform-direct runs go through a saved `platform_connection_id` automatically. BYO agent runs (`start_command` and `agent_url`) do not.
</credential_resolution>

<config_adapter_rules>
WebSocket (local agent via relay):
{
  "connection": {
    "adapter": "websocket",
    "start_command": "npm run start",
    "health_endpoint": "/health",
    "agent_port": 3001
  }
}

WebSocket (hosted custom agent):
{
  "connection": {
    "adapter": "websocket",
    "agent_url": "https://my-agent.fly.dev"
  }
}

Retell:
{
  "connection": {
    "adapter": "retell",
    "platform": { "provider": "retell" }
  }
}
Credentials auto-resolve from `.env.local`, `.env`, or shell env: RETELL_API_KEY, RETELL_AGENT_ID. Only add retell_api_key/retell_agent_id to the JSON if those env vars are not already available.

Bland:
{
  "connection": {
    "adapter": "bland",
    "platform": { "provider": "bland" }
  }
}
Credentials auto-resolve from `.env.local`, `.env`, or shell env: BLAND_API_KEY, BLAND_PATHWAY_ID. Only add bland_api_key/bland_pathway_id to the JSON if those env vars are not already available.
Note: All agent config (voice, model, tools, etc.) is set on the pathway itself, not in Vent config.

Vapi:
{
  "connection": {
    "adapter": "vapi",
    "platform": { "provider": "vapi" }
  }
}
Credentials auto-resolve from `.env.local`, `.env`, or shell env: VAPI_API_KEY, VAPI_ASSISTANT_ID. Only add vapi_api_key/vapi_assistant_id to the JSON if those env vars are not already available.
max_concurrency for Vapi: Starter=10, Growth=50, Enterprise=100+. Ask the user which tier they're on. If unknown, default to 10.
All assistant config (voice, model, transcriber, interruption settings, etc.) is set on the Vapi assistant itself, not in Vent config.

ElevenLabs:
{
  "connection": {
    "adapter": "elevenlabs",
    "platform": { "provider": "elevenlabs" }
  }
}
Credentials auto-resolve from `.env.local`, `.env`, or shell env: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID. Only add elevenlabs_api_key/elevenlabs_agent_id to the JSON if those env vars are not already available.

LiveKit:
{
  "connection": {
    "adapter": "livekit",
    "platform": {
      "provider": "livekit",
      "livekit_agent_name": "my-agent",
      "max_concurrency": 5
    }
  }
}
Credentials auto-resolve from `.env.local`, `.env`, or shell env: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL. Only add these to the JSON if those env vars are not already available.
livekit_agent_name is optional -- only needed if the agent registers with an explicit agent_name in WorkerOptions. Omit for automatic dispatch.
max_concurrency: Free/Build=5, Ship=20, Scale=50+. Ask the user which tier they're on. If unknown, default to 5.
</config_adapter_rules>
</config_connection>


<conversation_calls>
<tool_call_capture>
vapi/retell/elevenlabs/bland: automatic via platform API (no user code needed).
WebSocket/WebRTC: user's agent must emit tool calls:
  WebSocket — JSON text frame: {"type":"tool_call","name":"...","arguments":{},"result":{},"successful":true,"duration_ms":150}
  WebRTC/LiveKit — publishData() or sendText() on topic "vent:tool-calls". Same JSON.
</tool_call_capture>

<component_timing>
Platform adapters (vapi/retell/elevenlabs/bland/livekit) get STT/LLM/TTS breakdown automatically.
WebSocket agents can opt in by sending a JSON text frame after each agent turn:
  {"type":"vent:timing","stt_ms":120,"llm_ms":450,"tts_ms":80}
All fields optional. Send one per agent response. Without this, component_latency is omitted from results.
When modifying a WebSocket agent's code, add this text frame after TTS completes to enable component latency reporting.
</component_timing>

<config_conversation_calls>
{
  "conversation_calls": [
    {
      "name": "required — descriptive call name (e.g. reschedule-appointment, not call-1)",
      "caller_prompt": "required — caller persona and behavior (name -> goal -> emotion -> conditional behavior)",
      "max_turns": "required — default 6",
      "silence_threshold_ms": "optional — end-of-turn threshold ms (default 800, 200-10000). 800-1200 FAQ, 2000-3000 tool calls, 3000-5000 complex reasoning.",
      "persona": "optional — caller behavior controls",
      {
        "pace": "slow | normal | fast",
        "clarity": "clear | vague | rambling",
        "disfluencies": "true | false",
        "cooperation": "cooperative | reluctant | hostile",
        "emotion": "neutral | cheerful | confused | frustrated | skeptical | rushed",
        "interruption_style": "low (~3/10 turns) | high (~7/10 turns)",
        "memory": "reliable | unreliable",
        "intent_clarity": "clear | indirect | vague",
        "confirmation_style": "explicit | vague"
      },
      "audio_actions": "optional — per-turn audio stress calls",
      [
        { "action": "interrupt", "at_turn": "N", "prompt": "what caller says" },
        { "action": "silence", "at_turn": "N", "duration_ms": "1000-30000" },
        { "action": "inject_noise", "at_turn": "N", "noise_type": "babble | white | pink", "snr_db": "0-40" },
        { "action": "split_sentence", "at_turn": "N", "split": { "part_a": "...", "part_b": "...", "pause_ms": "500-5000" } },
        { "action": "noise_on_caller", "at_turn": "N" }
      ],
      "prosody": "optional — Hume emotion analysis (default false)",
      "caller_audio": "optional — omit for clean audio",
      {
        "noise": { "type": "babble | white | pink", "snr_db": "0-40" },
        "speed": "0.5-2.0 (1.0 = normal)",
        "speakerphone": "true | false",
        "mic_distance": "close | normal | far",
        "clarity": "0.0-1.0 (1.0 = perfect)",
        "accent": "american | british | australian | filipino | spanish_mexican | spanish_peninsular | spanish_colombian | spanish_argentine | german | french | italian | dutch | japanese",
        "packet_loss": "0.0-0.3",
        "jitter_ms": "0-100"
      },
      "language": "optional — ISO 639-1: en, es, fr, de, it, nl, ja",
      "repeat": "optional — run N times (1-10, default 1: increase to 2-3 for non-deterministic calls like barge-in, noise, tool calls)"
    }
  ]
}

<examples_conversation_calls>
<simple_conversation_test_example>
{
  "name": "reschedule-appointment-happy-path",
  "caller_prompt": "You are Maria, calling to reschedule her dentist appointment from Thursday to next Tuesday. She's in a hurry and wants this done quickly.",
  "max_turns": 8
}
</simple_conversation_test_example>

<advanced_conversation_test_example>
{
  "name": "noisy-interruption-booking",
  "caller_prompt": "You are James, an impatient customer calling from a loud coffee shop to book a plumber for tomorrow morning. You interrupt the agent mid-sentence when they start listing availability — you just want the earliest slot.",
  "max_turns": 12,
  "persona": { "pace": "fast", "cooperation": "reluctant", "emotion": "rushed", "interruption_style": "high" },
  "audio_actions": [
    { "action": "interrupt", "at_turn": 3, "prompt": "Just give me the earliest one!" },
    { "action": "inject_noise", "at_turn": 1, "noise_type": "babble", "snr_db": 15 }
  ],
  "caller_audio": { "noise": { "type": "babble", "snr_db": 20 }, "speed": 1.3 },
  "prosody": true,
  "repeat": 3
}
</advanced_conversation_test_example>

</examples_conversation_calls>
</config_conversation_calls>

<output_conversation_test>
{
  "name": "sarah-hotel-booking",
  "status": "completed",
  "caller_prompt": "You are Sarah, calling to book...",
  "duration_ms": 45200,
  "error": null,
  "transcript": [
    { "role": "caller", "text": "Hi, I'd like to book..." },
    { "role": "agent", "text": "Sure! What date?", "ttfb_ms": 650, "ttfw_ms": 780, "audio_duration_ms": 2400 },
    { "role": "agent", "text": "Let me check avail—", "ttfb_ms": 540, "ttfw_ms": 620, "audio_duration_ms": 1400, "interrupted": true },
    { "role": "caller", "text": "Just the earliest slot please", "audio_duration_ms": 900, "is_interruption": true },
    { "role": "agent", "text": "Sure, the earliest is 9 AM tomorrow.", "ttfb_ms": 220, "ttfw_ms": 260, "audio_duration_ms": 2100 }
  ],
  "latency": {
    "mean_ttfw_ms": 890, "p50_ttfw_ms": 850, "p95_ttfw_ms": 1400, "p99_ttfw_ms": 1550,
    "first_turn_ttfw_ms": 1950, "total_silence_ms": 4200, "mean_turn_gap_ms": 380,
    "drift_slope_ms_per_turn": -45.2, "mean_silence_pad_ms": 128, "mouth_to_ear_est_ms": 1020
  },
  "transcript_quality": {
    "wer": 0.04,
    "hallucination_events": [
      { "error_count": 5, "reference_text": "triple five one two", "hypothesis_text": "five five five nine two" }
    ],
    "repetition_score": 0.05,
    "reprompt_count": 0,
    "filler_word_rate": 0.8,
    "words_per_minute": 148
  },
  "audio_analysis": {
    "agent_speech_ratio": 0.72,
    "interruption_rate": 0.25,
    "interruption_count": 1,
    "barge_in_recovery_time_ms": 280,
    "agent_interrupting_user_rate": 0.0,
    "agent_interrupting_user_count": 0,
    "missed_response_windows": 0,
    "longest_monologue_ms": 5800,
    "silence_gaps_over_2s": 1,
    "total_internal_silence_ms": 2400,
    "mean_agent_speech_segment_ms": 3450
  },
  "tool_calls": {
    "total": 2, "successful": 2, "failed": 0, "mean_latency_ms": 340,
    "names": ["check_availability", "book_appointment"],
    "observed": [{ "name": "check_availability", "arguments": { "date": "2026-03-12" }, "result": { "slots": ["09:00", "10:00"] }, "successful": true, "latency_ms": 280, "turn_index": 3 }]
  },
  "call_metadata": {
    "platform": "vapi",
    "recording_url": "https://example.com/recording"
  },
  "warnings": [],
  "audio_actions": [
    { "at_turn": 5, "action": "silence", "metrics": { "agent_prompted": false, "unprompted_utterance_count": 0, "silence_duration_ms": 8000 } }
  ],
  "emotion": {
    "naturalness": 0.72, "mean_calmness": 0.65, "mean_confidence": 0.58, "peak_frustration": 0.08, "emotion_trajectory": "stable"
  }
}

All fields optional except name, status, caller_prompt, duration_ms, transcript. Fields appear only when relevant analysis ran (e.g., emotion requires prosody: true).

### Result presentation

When you report a conversation result to the user, always include:

1. **Summary** — the overall verdict and the 1-3 most important findings.
2. **Transcript summary** — a short narrative of what happened in the call.
3. **Recording URL** — include `call_metadata.recording_url` when present; explicitly say when it is unavailable.
4. **Next steps** — concrete fixes, follow-up tests, or why no change is needed.

Use metrics to support the summary, not as the whole answer. Do not dump raw numbers without interpretation.

When `call_metadata.transfer_attempted` is present, explicitly say whether the transfer only appeared attempted or was mechanically verified as completed. If `call_metadata.transfers[*].verification` is present, use it to mention second-leg observation, connect latency, transcript/context summary, and whether context passing was verified.

### Judging guidance

Use the transcript, metrics, test scenario, and relevant agent instructions/system prompt to judge:

| Dimension | What to check |
|--------|----------------|
| **Hallucination detection** | Check whether the agent stated anything not grounded in its instructions, tools, or the conversation itself. Treat `transcript_quality.hallucination_events` only as a speech-recognition warning signal, not proof of agent hallucination. |
| **Instruction following** | Compare the agent's behavior against its system prompt and the test's expected constraints. |
| **Context retention** | Check whether the agent forgot or contradicted information established earlier in the call. |
| **Semantic accuracy** | Check whether the agent correctly understood the caller's intent and responded to the real request. |
| **Goal completion** | Decide whether the agent achieved what the test scenario was designed to verify. |
| **Transfer correctness** | For transfer scenarios, judge whether transfer was appropriate, whether it completed, whether it went to the expected destination, and whether enough context was passed during the handoff. |

### Interruption evaluation

When the transcript contains `interrupted: true` / `is_interruption: true` turns, evaluate these metrics by reading the transcript:

| Metric | How to evaluate | Target |
|--------|----------------|--------|
| **Recovery rate** | For each interrupted turn: does the post-interrupt agent response acknowledge or address the interruption? | >90% |
| **Context retention** | After the interruption, does the agent remember pre-interrupt conversation state? | >95% |
| **Barge-in recovery time** | Use `audio_analysis.barge_in_recovery_time_ms` when available. Lower is better because it measures how long the agent kept speaking after the caller cut in. | <500ms acceptable |
| **Agent interrupting user rate** | Use `audio_analysis.agent_interrupting_user_rate` and the transcript to see whether the agent starts speaking before the caller finished. | 0 ideal |

Report these alongside standard metrics when interruption calls run.
</output_conversation_test>
</conversation_calls>


## Exit Codes

0=pass, 1=fail, 2=error
