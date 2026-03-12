# VoiceCI

CI/CD testing for voice AI agents. Test latency, barge-in handling, echo detection, conversation quality, and tool calls — all from your coding agent via MCP.

## Quick Setup

VoiceCI runs as a remote MCP server. No installation needed — just connect your editor.

### Claude Code

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer voiceci_YOUR_KEY" \
  voiceci "https://voiceci-api.fly.dev/mcp"
```

Use `--scope user` to make it available across all projects:

```bash
claude mcp add --transport http --scope user \
  --header "Authorization: Bearer voiceci_YOUR_KEY" \
  voiceci "https://voiceci-api.fly.dev/mcp"
```

### Cursor

Add to `.cursor/mcp.json` (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "voiceci": {
      "type": "http",
      "url": "https://voiceci-api.fly.dev/mcp",
      "headers": {
        "Authorization": "Bearer voiceci_YOUR_KEY"
      }
    }
  }
}
```

> **Note**: The `"type": "http"` field is required. Without it, Cursor falls back to OAuth which will fail.

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "voiceci": {
      "serverUrl": "https://voiceci-api.fly.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${env:VOICECI_API_KEY}"
      }
    }
  }
}
```

### Team Sharing

Add `.mcp.json` to your project root and check it into git:

```json
{
  "mcpServers": {
    "voiceci": {
      "type": "http",
      "url": "https://voiceci-api.fly.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${VOICECI_API_KEY}"
      }
    }
  }
}
```

Teammates just set `export VOICECI_API_KEY=voiceci_their_key` and it works.

## What You Can Test

Once connected, ask your coding agent to test your voice agent. VoiceCI provides:

- **Audio tests** — echo detection, time-to-first-byte latency, barge-in handling, silence handling, connection stability, response completeness
- **Conversation tests** — multi-turn scenarios with configurable personas, LLM-judged pass/fail evaluations, behavioral scoring (quality, empathy, safety)
- **Tool call testing** — verify your agent calls the right tools with correct arguments
- **Load testing** — ramp, spike, sustained, and soak patterns with auto-detected breaking points

Supports 7 adapters: WebSocket (`websocket`), SIP/phone (`sip`), WebRTC/LiveKit (`webrtc`), Vapi, Retell, ElevenLabs, and Bland.

## MCP Tools

After connecting, these tools are available to your coding agent:

| Tool | Purpose |
|------|---------|
| `voiceci_run_tests` | Run audio + conversation tests (relay connects your local agent automatically) |
| `voiceci_run_load_test` | Run load/stress tests with traffic patterns (ramp, spike, sustained, soak) |
| `voiceci_get_run_status` | Check run status and get partial/final results |
| `voiceci_guide_setup` | Installation and connection instructions |
| `voiceci_guide_test_authoring` | Design tests — file format, agent analysis, personas, conversation authoring |
| `voiceci_guide_results` | Interpret results — failure diagnosis, metrics, iterative testing |
| `voiceci_guide_audio_tests` | Audio test definitions, durations, and threshold customization |
| `voiceci_guide_security_and_tools` | Red-team attack patterns and tool call integration guides |

## License

MIT
