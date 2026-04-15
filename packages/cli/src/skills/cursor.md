---
description: Vent — Voice agent calls. Run calls against your voice agent, get pass/fail results. Use when the user asks to run voice-agent calls or when you need to verify voice agent behavior after code changes.
alwaysApply: true
---

# Vent — Voice Agent Calls

Call voice agents from the terminal. Calls run in the cloud (30-120s).

## When to Call (read this first)

- After modifying voice agent code (system prompt, tools, handlers): ALWAYS run calls
- After changing audio config: run calls
- Before marking a task complete that touches agent behavior: run calls
- Do NOT skip call verification — voice agents are non-deterministic, small changes can break flows

## LiveKit Agent Setup (REQUIRED before running LiveKit tests)

When the user asks to test, configure, or run anything with a LiveKit agent, you MUST install the Vent LiveKit helper in the agent project and add the instrumentation call to the agent entrypoint BEFORE running any Vent calls.
- Node.js: `npm install @vent-hq/livekit`, then add `instrumentLiveKitAgent({ ctx, session })` to the agent entrypoint.
- Python: `pip install vent-livekit`, then add `instrument_livekit_agent(ctx=ctx, session=session)` to the agent entrypoint.
Without this, Vent cannot capture metrics, tool calls, usage, or session reports from the LiveKit agent.

Before running a LiveKit test, verify the agent process is running (`ps aux | grep <agent_process>`). If it's not running, start it before attempting any calls.

LiveKit worker restart caveat: After restarting a LiveKit agent process, wait at least 60 seconds before running a Vent call. If calls were attempted against stale workers (failed with "agent did not speak" or "no speech detected"), kill the agent, wait 60 seconds for ALL stale workers to deregister, then restart. Do not restart the agent multiple times in quick succession — each restart creates another stale worker registration that compounds the problem.

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
| `npx vent-hq run -f .vent/suite.<adapter>.json` | Run a call from suite file (auto-selects if only one call) |
| `npx vent-hq run -f .vent/suite.<adapter>.json --verbose` | Include debug fields in the result JSON |
| `npx vent-hq run -f .vent/suite.<adapter>.json --call <name>` | Run a specific named call |
| `npx vent-hq stop <run-id>` | Cancel a queued or running call |
| `npx vent-hq status <run-id>` | Check results of a previous run |
| `npx vent-hq status <run-id> --verbose` | Re-print a run with debug fields included |

## When To Use `--verbose`

Default output is enough for most work. It already includes:
- transcript
- latency
- audio analysis
- tool calls
- summary cost / recording / transfers

Use `--verbose` only when you need debugging detail that is not in the default result:
- per-turn debug fields: timestamps, caller decision mode, silence pad, STT confidence, platform transcript
- raw signal analysis: `debug.signal_quality`
- harness timings: `debug.harness_overhead`
- raw prosody payload and warnings
- raw provider warnings
- per-turn component latency arrays
- raw observed tool-call timeline
- provider-specific metadata in `debug.provider_metadata`

Trigger `--verbose` when:
- transcript accuracy looks wrong and you need to inspect `platform_transcript`
- latency is bad and you need per-turn/component breakdowns
- interruptions/barge-in behavior looks wrong
- tool-call execution looks inconsistent or missing
- the provider returned warnings/errors or you need provider-native artifacts

Skip `--verbose` when:
- you only need pass/fail, transcript, latency, tool calls, recording, or summary
- you are doing quick iteration on prompt wording and the normal result already explains the failure

## Normalization Contract

Vent always returns one normalized result shape on `stdout` across adapters. Treat these as the stable categories:
- `transcript`
- `latency`
- `audio_analysis`
- `tool_calls`
- `component_latency`
- `call_metadata`
- `warnings`
- `audio_actions`
- `emotion`

Source-of-truth policy:
- Vent computes transcript, latency, and audio-quality metrics itself.
- Hosted adapters choose the best source per category, usually provider post-call data for tool calls, call metadata, transfers, provider transcripts, and recordings.
- Realtime provider events are fallback or enrichment only when post-call data is missing, delayed, weaker for that category, or provider-specific.
- `LiveKit` helper events are the provider-native path for rich in-agent observability.
- `websocket`/custom agents are realtime-native but still map into the same normalized categories.
- Keep adapter-specific details in `call_metadata.provider_metadata` or `debug.provider_metadata`, not in new top-level fields.


## Critical Rules

1. **Run all calls in parallel in ONE shell command** — Cursor cannot run multiple shell tool calls concurrently. Instead, launch all calls in a **single** shell command using `&` and `wait`. Example: `npx vent-hq run -f .vent/suite.bland.json --call call-1 & npx vent-hq run -f .vent/suite.bland.json --call call-2 & wait`. Set a 300-second (5 min) timeout. NEVER run calls as separate commands — they will serialize.
2. **Handle backgrounded commands** — If a call command gets moved to background by the system, wait for it to complete before proceeding. Never end your response without delivering call results.
3. **Output format** — In non-TTY mode (when run by an agent), every SSE event is written to stdout as a JSON line. Results are always in stdout.
4. **This skill is self-contained** — The full config schema is below. Do NOT re-read this file.
5. **Always analyze results** — The run command outputs complete JSON with full transcript, latency, and tool calls. Use `--verbose` only when the default result is not enough to explain the failure. Analyze this output directly — do NOT run `vent status` afterwards unless you are re-checking a past run.

## Workflow

### First time: create the call suite

1. Read the voice agent's codebase — understand its system prompt, tools, intents, and domain.
2. Read the **Full Config Schema** section below for all available fields.
3. Create the suite file in `.vent/` using the naming convention: `.vent/suite.<adapter>.json` (e.g., `.vent/suite.vapi.json`, `.vent/suite.websocket.json`, `.vent/suite.retell.json`). This prevents confusion when multiple adapters are tested in the same project.
   - Name calls after specific flows (e.g., `"reschedule-appointment"`, not `"call-1"`)
   - Write `caller_prompt` as a realistic persona with a specific goal, based on the agent's domain
   - Set `max_turns` based on the flow complexity (simple FAQ: 4-6, booking: 8-12, complex: 12-20)

### Multiple suite files

If `.vent/` contains more than one suite file, **always check which adapter each suite uses before running**. Read the `connection.adapter` field in each file. Never run a suite intended for a different adapter — results will be meaningless or fail. When reporting results, always state which suite file produced them (e.g., "Results from `.vent/suite.vapi.json`:").

### Subsequent runs — reuse the existing suite

A matching `.vent/suite.<adapter>.json` already exists? Just re-run it. No need to recreate.

### Run calls

1. If the suite uses `start_command`, start the shared local session first:
   ```
   npx vent-hq agent start -f .vent/suite.<adapter>.json
   ```

2. Run calls:
   ```
   # suite with one call (auto-selects)
   npx vent-hq run -f .vent/suite.<adapter>.json

   # suite with multiple calls — pick one by name
   npx vent-hq run -f .vent/suite.<adapter>.json --call happy-path

   # local start_command — add --session
   npx vent-hq run -f .vent/suite.<adapter>.json --call happy-path --session <session-id>
   ```

3. To run multiple calls from the same suite, **run them in parallel in one shell command**:
   ```
   npx vent-hq run -f .vent/suite.vapi.json --call happy-path & npx vent-hq run -f .vent/suite.vapi.json --call edge-case & wait
   ```

4. Analyze each result, identify failures, correlate with the codebase, and fix.
5. **Compare with previous run** — Vent saves full result JSON to `.vent/runs/` after every run. Read the second-most-recent JSON in `.vent/runs/` and compare against the current run: status flips, TTFW p50/p95 changes >20%, tool call count drops, cost increases >30%, transcript divergence. Correlate with `git diff` between the two runs' git SHAs. Skip if no previous run exists.

## Connection

- **BYO agent runtime**: your agent owns its own provider credentials. Use `start_command` for a local agent or `agent_url` for a hosted custom endpoint.
- **Platform-direct runtime**: use adapter `vapi | retell | elevenlabs | bland | livekit`. This is the only mode where Vent itself needs provider credentials and saved platform connections apply.

## WebSocket Protocol (BYO agents)

When using `adapter: "websocket"`, Vent communicates with the agent over a single WebSocket connection:

- **Binary frames** → PCM audio (16-bit mono, configurable sample rate)
- **Text frames** → optional JSON events the agent can send for better test accuracy:

| Event | Format | Purpose |
|-------|--------|---------|
| `speech-update` | `{"type":"speech-update","status":"started"\|"stopped"}` | Enables platform-assisted turn detection (more accurate than VAD alone) |
| `tool_call` | `{"type":"tool_call","name":"...","arguments":{...},"result":...,"successful":bool,"duration_ms":number}` | Reports tool calls for observability |
| `vent:timing` | `{"type":"vent:timing","stt_ms":number,"llm_ms":number,"tts_ms":number}` | Reports component latency breakdown per turn |
| `vent:session` | `{"type":"vent:session","platform":"custom","provider_call_id":"...","provider_session_id":"..."}` | Reports stable provider/session identifiers |
| `vent:call-metadata` | `{"type":"vent:call-metadata","call_metadata":{...}}` | Reports post-call metadata such as cost, recordings, variables, and provider-specific artifacts |
| `vent:transcript` | `{"type":"vent:transcript","role":"caller"\|"agent","text":"...","turn_index":0}` | Reports platform/native transcript text for caller or agent |
| `vent:transfer` | `{"type":"vent:transfer","destination":"...","status":"attempted"\|"completed"}` | Reports transfer attempts and outcomes |
| `vent:debug-url` | `{"type":"vent:debug-url","label":"log","url":"https://..."}` | Reports provider debug/deep-link URLs |
| `vent:warning` | `{"type":"vent:warning","message":"...","code":"..."}` | Reports provider/runtime warnings worth preserving in run metadata |

Vent sends `{"type":"end-call"}` to the agent when the test is done.

All text frames are optional — audio-only agents work fine with VAD-based turn detection.

## Full Config Schema

- ALL calls MUST reference the agent's real context (system prompt, tools, knowledge base) from the codebase.

<vent_run>
{
  "connection": { ... },
  "calls": {
    "happy-path": { ... },
    "edge-case": { ... }
  }
}
</vent_run>

One suite file per platform/adapter. `connection` is declared once, `calls` is a named map of call specs. Each key becomes the call name. Run one call at a time with `--call <name>`.

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
6. **IMPORTANT: `npx vent-hq` commands auto-load `.env` files — never use `source .env && export` before running them.** Only your own custom scripts (e.g. `npx tsx my-script.ts`) need manual env loading. To add a new credential, just append it to `.env` and the CLI picks it up automatically on the next run.

Auto-resolved env vars per platform:
| Platform | Config field | Env var (auto-resolved from `.env.local`, `.env`, or shell env) |
|----------|-------------|-----------------------------------|
| Vapi | vapi_api_key | VAPI_API_KEY |
| Vapi | vapi_assistant_id | VAPI_ASSISTANT_ID or VAPI_AGENT_ID |
| Bland | bland_api_key | BLAND_API_KEY |
| Bland | bland_pathway_id | BLAND_PATHWAY_ID |
| Bland | persona_id | BLAND_PERSONA_ID |
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
max_concurrency for Retell: Pay-as-you-go includes 20 concurrent calls, with more available on demand; Enterprise has no cap. Ask the user which plan they're on. If unknown, default to 20.

Bland:
{
  "connection": {
    "adapter": "bland",
    "platform": { "provider": "bland" }
  }
}
Credentials auto-resolve from `.env.local`, `.env`, or shell env: BLAND_API_KEY, BLAND_PATHWAY_ID, BLAND_PERSONA_ID. Only add bland_api_key/bland_pathway_id/persona_id to the JSON if those env vars are not already available.
max_concurrency for Bland: Start=10, Build=50, Scale=100, Enterprise=unlimited. Ask the user which plan they're on. If unknown, default to 10.
Note: All agent config (voice, model, tools, etc.) is set on the pathway itself, not in Vent config.

Vapi:
{
  "connection": {
    "adapter": "vapi",
    "platform": { "provider": "vapi" }
  }
}
Credentials auto-resolve from `.env.local`, `.env`, or shell env: VAPI_API_KEY, VAPI_ASSISTANT_ID (or VAPI_AGENT_ID). Only add vapi_api_key/vapi_assistant_id to the JSON if those env vars are not already available.
max_concurrency for Vapi: every account includes 10 concurrent call slots by default; self-serve accounts can buy extra reserved lines, and Enterprise includes unlimited concurrency. Set this to the user's purchased limit. If unknown, default to 10.
All assistant config (voice, model, transcriber, interruption settings, etc.) is set on the Vapi assistant itself, not in Vent config.

ElevenLabs:
{
  "connection": {
    "adapter": "elevenlabs",
    "platform": { "provider": "elevenlabs" }
  }
}
Credentials auto-resolve from `.env.local`, `.env`, or shell env: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID. Only add elevenlabs_api_key/elevenlabs_agent_id to the JSON if those env vars are not already available.
max_concurrency for ElevenLabs: Free=4, Starter=6, Creator=10, Pro=20, Scale=30, Business=30. Burst pricing can temporarily allow up to 3x the base limit. Ask the user which plan they're on and whether burst is enabled. If unknown, default to 4.

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
The livekit adapter requires the LiveKit Agents SDK. It depends on Agents SDK signals (lk.agent.state, lk.transcription) for readiness detection, turn timing, and component latency. Custom LiveKit participants not using the Agents SDK should use the websocket adapter with a relay instead.
max_concurrency for LiveKit Cloud: Build=5, Ship=20, Scale=50 managed inference sessions. Agent session concurrency can be higher (Build=5, Ship=20, Scale up to 600), but managed inference is the usual gating limit for voice agents. Ask the user which tier they're on. If unknown, default to 5.
Know the provider/account concurrency limits and use them in planning, but Vent does not enforce provider caps at runtime. Hosted worker throughput is an infra setting: `WORKER_TOTAL_CONCURRENCY` caps one worker Machine.
</config_adapter_rules>
</config_connection>


<call_config>
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

<metadata_capture>
WebSocket and LiveKit/WebRTC agents can also emit richer observability metadata:
  {"type":"vent:session","platform":"custom","provider_call_id":"call_123","provider_session_id":"session_abc"}
  {"type":"vent:call-metadata","call_metadata":{"recording_url":"https://...","cost_usd":0.12,"provider_debug_urls":{"log":"https://..."}}}
  {"type":"vent:debug-url","label":"trace","url":"https://..."}
  {"type":"vent:session-report","report":{"room_name":"room-123","events":[...],"metrics":[...]}}
  {"type":"vent:metrics","event":"metrics_collected","metric_type":"eou","metrics":{"speechId":"speech_123","endOfUtteranceDelayMs":420}}
  {"type":"vent:function-tools-executed","event":"function_tools_executed","hasAgentHandoff":true,"tool_calls":[{"name":"lookup_customer","arguments":{"id":"123"}}]}
  {"type":"vent:conversation-item","event":"conversation_item_added","item":{"type":"agent_handoff","newAgentId":"billing-agent"}}
  {"type":"vent:session-usage","usage":{"llm":{"promptTokens":123,"completionTokens":45}}}
Transport:
  WebSocket — send JSON text frames with these payloads. WebSocket agents may also emit {"type":"vent:transcript","role":"caller","text":"I need to reschedule","turn_index":0} when they have native transcript text.
  WebRTC/LiveKit — publishData() or sendText() on the matching "vent:*" topic, e.g. topic "vent:call-metadata" with the JSON body above.
For LiveKit, transcript and timing stay authoritative from native room signals (`lk.transcription`, `lk.agent.state`). Do not emit `vent:transcript` from LiveKit agents.
For LiveKit agents, prefer the first-party helper instead of manual forwarding:
Node.js — `npm install @vent-hq/livekit`:
```ts
import { instrumentLiveKitAgent } from "@vent-hq/livekit";

const vent = instrumentLiveKitAgent({
  ctx,
  session,
});
```
Python — `pip install vent-livekit`:
```python
from vent_livekit import instrument_livekit_agent

vent = instrument_livekit_agent(ctx=ctx, session=session)
```
This helper must run inside the LiveKit agent runtime with the existing Agents SDK `session` and `ctx` objects. It is the Vent integration layer on top of the Agents SDK, not a replacement for it.
This automatically publishes only the in-agent-only LiveKit signals: `metrics_collected`, `function_tools_executed`, `conversation_item_added`, and a session report on close/shutdown.
Do not use it to mirror room-visible signals like transcript, agent state timing, or room/session ID — Vent already gets those from LiveKit itself.
For LiveKit inside-agent forwarding, prefer sending the raw LiveKit event payloads on:
  `vent:metrics`
  `vent:function-tools-executed`
  `vent:conversation-item`
  `vent:session-usage`
Use these metadata events when the agent runtime already knows native IDs, recordings, warnings, debug links, session reports, metrics events, or handoff artifacts. This gives custom and LiveKit agents parity with hosted adapters without needing a LiveKit Cloud connector.
</metadata_capture>

<config_call>
Each call in the `calls` map. The key is the call name (e.g. `"reschedule-appointment"`, not `"call-1"`).
{
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
      "interruption_style": "optional preplanned interrupt tendency: low | high. If set, Vent may pre-plan a caller cut-in before the agent turn starts. It does NOT make a mid-turn interrupt LLM call.",
      "memory": "reliable | unreliable",
      "intent_clarity": "clear | indirect | vague",
      "confirmation_style": "explicit | vague"
    },
    "audio_actions": "optional — per-turn audio stress calls",
    [
      { "action": "interrupt", "at_turn": "N", "prompt": "what caller says" },
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
    "language": "optional — ISO 639-1: en, es, fr, de, it, nl, ja"
}

Interruption rules:
- `audio_actions: [{ "action": "interrupt", ... }]` is the deterministic per-turn interrupt test. Prefer this for evaluation.
- `persona.interruption_style` is only a preplanned caller tendency. If used, Vent decides before the agent response starts whether this turn may cut in.
- Vent no longer pauses mid-turn to ask a second LLM whether to interrupt.
- For production-faithful testing, prefer explicit `audio_actions.interrupt` over persona interruption.

<examples_call>
<simple_suite_example>
{
  "connection": {
    "adapter": "vapi",
    "platform": { "provider": "vapi" }
  },
  "calls": {
    "reschedule-appointment": {
      "caller_prompt": "You are Maria, calling to reschedule her dentist appointment from Thursday to next Tuesday. She's in a hurry and wants this done quickly.",
      "max_turns": 8
    },
    "cancel-appointment": {
      "caller_prompt": "You are Tom, calling to cancel his appointment for Friday. He's calm and just wants confirmation.",
      "max_turns": 6
    }
  }
}
</simple_suite_example>

<advanced_call_example>
A call entry with advanced options (persona, audio actions, prosody):
{
  "noisy-interruption-booking": {
    "caller_prompt": "You are James, an impatient customer calling from a loud coffee shop to book a plumber for tomorrow morning. You interrupt the agent mid-sentence when they start listing availability — you just want the earliest slot.",
    "max_turns": 12,
    "persona": { "pace": "fast", "cooperation": "reluctant", "emotion": "rushed", "interruption_style": "high" },
    "audio_actions": [
      { "action": "interrupt", "at_turn": 3, "prompt": "Just give me the earliest one!" },
      { "action": "inject_noise", "at_turn": 1, "noise_type": "babble", "snr_db": 15 }
    ],
    "caller_audio": { "noise": { "type": "babble", "snr_db": 20 }, "speed": 1.3 },
    "prosody": true
  }
}
</advanced_call_example>

</examples_call>
</config_call>

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
    "response_time_ms": 890, "response_time_source": "ttfw",
    "p50_response_time_ms": 850, "p90_response_time_ms": 1100, "p95_response_time_ms": 1400, "p99_response_time_ms": 1550,
    "first_response_time_ms": 1950,
    "mean_ttfw_ms": 890, "p50_ttfw_ms": 850, "p95_ttfw_ms": 1400, "p99_ttfw_ms": 1550,
    "first_turn_ttfw_ms": 1950, "total_silence_ms": 4200, "mean_turn_gap_ms": 380,
    "drift_slope_ms_per_turn": -45.2, "mean_silence_pad_ms": 128, "mouth_to_ear_est_ms": 1020
  },
  "audio_analysis": {
    "caller_talk_time_ms": 12400,
    "agent_talk_time_ms": 28500,
    "agent_speech_ratio": 0.72,
    "talk_ratio_vad": 0.69,
    "interruption_rate": 0.25,
    "interruption_count": 1,
    "agent_overtalk_after_barge_in_ms": 280,
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
  "component_latency": {
    "mean_stt_ms": 120, "mean_llm_ms": 450, "mean_tts_ms": 80,
    "p95_stt_ms": 180, "p95_llm_ms": 620, "p95_tts_ms": 110,
    "mean_speech_duration_ms": 2100,
    "bottleneck": "llm"
  },
  "call_metadata": {
    "platform": "vapi",
    "cost_usd": 0.08,
    "recording_url": "https://example.com/recording",
    "ended_reason": "customer_ended_call",
    "transfers": []
  },
  "warnings": [],
  "audio_actions": [],
  "emotion": {
    "naturalness": 0.72, "mean_calmness": 0.65, "mean_confidence": 0.58, "peak_frustration": 0.08, "emotion_trajectory": "stable"
  }
}

Always present: name, status, caller_prompt, duration_ms, error, transcript, tool_calls, warnings, audio_actions. Nullable when analysis didn't run: latency, audio_analysis, component_latency, call_metadata, emotion (requires prosody: true), debug (requires --verbose).

### Result presentation

When you report a conversation result to the user, always include:

1. **Summary** — the overall verdict and the 1-3 most important findings.
2. **Transcript summary** — a short narrative of what happened in the call.
3. **Recording URL** — include `call_metadata.recording_url` when present; explicitly say when it is unavailable.
4. **Next steps** — concrete fixes, follow-up tests, or why no change is needed.

Use metrics to support the summary, not as the whole answer. Do not dump raw numbers without interpretation.

When `call_metadata.transfer_attempted` is present, explicitly say whether the transfer only appeared attempted or was mechanically verified as completed (`call_metadata.transfer_completed`). Use `call_metadata.transfers[]` to report transfer type, destination, status, and sources.

### Judging guidance

Use the transcript, metrics, test scenario, and relevant agent instructions/system prompt to judge:

| Dimension | What to check |
|--------|----------------|
| **Hallucination detection** | Check whether the agent stated anything not grounded in its instructions, tools, or the conversation itself. |
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
| **Agent overtalk after barge-in** | Use `audio_analysis.agent_overtalk_after_barge_in_ms` when available. Lower is better because it measures how long the agent kept speaking after the caller cut in. | <500ms acceptable |
| **Agent interrupting user rate** | Use `audio_analysis.agent_interrupting_user_rate` and the transcript to see whether the agent starts speaking before the caller finished. | 0 ideal |

Report these alongside standard metrics when interruption calls run.
</output_conversation_test>
</call_config>


## Exit Codes

0=pass, 1=fail, 2=error

## Vent Access Token

Set `VENT_ACCESS_TOKEN` env var or run `npx vent-hq login`.
