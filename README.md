<p align="center">
  <img src=".github/logo.png" alt="Vent" width="80" />
</p>

<p align="center">
  <strong>Agent CLI for voice AI development</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vent-hq"><img src="https://img.shields.io/npm/v/vent-hq" alt="npm" /></a>
  <a href="https://github.com/vent-hq/vent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License" /></a>
</p>


---

### What is Vent?

Vent is a CLI for coding agents that lets them place calls and evaluate voice agents through vocal agent-to-agent communication. It works with Vapi, Retell, LiveKit, ElevenLabs, Bland, and custom endpoints.

### How It Works

Your coding agent gains full observability into how prompts, flows, tool calls, transfers, MCPs, fallbacks, and other logic is actually executed, giving it real information that leads to more accurate fixes and less hallucination. Vent can be adapted to simulate any persona (defaults to neutral).

1. Your agent writes a Vent caller config and runs `vent run`. Vent joins the call.
2. Each call returns 60+ computed metrics on top of a full transcript, recorded audio, and call metadata. Results are stored locally so the agent can compare across runs.

### Install

```bash
npx vent-hq@latest init                          # Agent auto-setup: auth, skills, config
```

The `init` command lets the agent automatically log in via GitHub, generate an access token, install skill files, and scaffold a starter config at `.vent/suite.json`. For access without GitHub, run `login` and then `init`.

### Quick Start

```bash
npx vent-hq@latest init                          # Auto-setup
npx vent-hq run -f .vent/suite.json              # Run all calls, stream results
npx vent-hq run -f .vent/suite.json --call foo   # Run a specific call
```

### Platform Integrations

#### Vapi, Retell, and ElevenLabs

Hosted only. Set your API key and agent/assistant ID in `.env` and you're ready to go.

#### LiveKit

Test local agents in dev mode or deployed agents on LiveKit Cloud — same config, different `LIVEKIT_URL`. Optionally target a specific agent with `livekit_agent_name`.

Requires [`@vent-hq/livekit`](https://www.npmjs.com/package/@vent-hq/livekit) (Node) or [`vent-livekit`](https://pypi.org/project/vent-livekit/) (Python) instrumentation for full observability (tool calls, component latency, session usage). Without it, Vent still captures agent state transitions and transcriptions from the Agents SDK.

#### Bland

Test pathways (`bland_pathway_id`), personas (`persona_id`), or inline prompts (`task`).

#### Custom

For voice agents not hosted on a specific platform, you can test over WebSocket. Point Vent at a hosted endpoint with `agent_url`, or test a local agent with `start_command` + `agent_port` — Vent spawns your agent and tunnels audio through a relay so your machine doesn't need a public IP. Agents are required to emit `vent:*` events for full observability and reliable turn detection.

---

[Website](https://vent.dev) · [Documentation](https://docs.vent.dev) · [Changelog](https://github.com/vent-hq/vent/blob/main/CHANGELOG.md) · [X](https://x.com/vent_hq)
