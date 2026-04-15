<!-- banner placeholder -->

<p align="center">
  <strong>Ship reliable voice agents without leaving your editor.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vent-hq"><img src="https://img.shields.io/npm/v/vent-hq" alt="npm" /></a>
  <a href="https://github.com/vent-hq/vent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License" /></a>
</p>


<br>
<br>

## What is Vent?

Vent is a CLI that lets coding agents call, evaluate, and fix voice agents through vocal agent-to-agent communication. It works with Vapi, Retell, LiveKit, ElevenLabs, Bland, and custom endpoints.

## How It Works

Describe the exact persona, flows, tool calls, transfers, MCPs, logic fallbacks, and other perks you need — your coding agent performs test calls with Vent until that behavior is proven to work.

1. Your coding agent writes a test config based on collected context and runs `vent run`. Vent connects to your agent and joins the call as a realistic caller that vocally converses with the agent.
2. At the end of each call, the coding agent's stdout receives 60+ computed metrics on top of the full transcript, recorded audio, and call metadata — enough for the coding agent to pinpoint what's wrong and fix it. Results of all runs are stored locally so the agent can compare against previous runs.

## Install

```bash
npx vent-hq@latest init
```

Paste `npx vent-hq@latest init` into your coding agent. It will automatically log in via GitHub, generate an access token, install skill files, and scaffold a starter config at `.vent/suite.json`. Your coding agent is ready to run calls.

For unlimited access without GitHub, run `npx vent-hq login` to authenticate via browser.

## Usage

Your coding agent writes the test config, here's what a minimal one looks like:

```json
{
  "connection": {
    "adapter": "vapi"
  },
  "calls": {
    "reschedule-appointment": {
      "caller_prompt": "You are Maria calling to reschedule her dentist appointment from Thursday to next Tuesday.",
      "max_turns": 8
    }
  }
}
```

```bash
npx vent-hq run -f .vent/suite.json              # Run all calls, stream results
npx vent-hq run -f .vent/suite.json --call foo   # Run a specific call
```

## Platform Integrations

### Vapi, Retell, and ElevenLabs

Hosted only. Set your API key and agent/assistant ID in `.env` and you're ready to go.

### LiveKit

Test local agents in dev mode or deployed agents on LiveKit Cloud — same config, different `LIVEKIT_URL`. Optionally target a specific agent with `livekit_agent_name`.

Requires [`@vent-hq/livekit`](https://www.npmjs.com/package/@vent-hq/livekit) (Node) or [`vent-livekit`](https://pypi.org/project/vent-livekit/) (Python) instrumentation for full observability (tool calls, component latency, session usage). Without it, Vent still captures agent state transitions and transcriptions from the Agents SDK.

### Bland

Test pathways (`bland_pathway_id`), personas (`persona_id`), or inline prompts (`task`).

### Custom

For voice agents not hosted on a specific platform, you can test over WebSocket. Point Vent at a hosted endpoint with `agent_url`, or test a local agent with `start_command` + `agent_port` — Vent spawns your agent and tunnels audio through a relay so your machine doesn't need a public IP. Agents are required to emit `vent:*` events for full observability and reliable turn detection.

---

[Website](https://vent.dev) · [Documentation](https://docs.vent.dev) · [Changelog](https://github.com/vent-hq/vent/blob/main/CHANGELOG.md) · [X](https://x.com/vent_hq)
