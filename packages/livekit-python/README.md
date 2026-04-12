# vent-livekit

Thin helper for forwarding LiveKit Agents SDK observability into Vent.

## Install

```bash
pip install vent-livekit
```

## What it does

`instrument_livekit_agent()` automatically publishes the existing `vent:*` topics that the Vent LiveKit adapter already understands:

- `vent:metrics`
- `vent:function-tools-executed`
- `vent:conversation-item`
- `vent:user-input-transcribed`
- `vent:session-usage`
- `vent:session-report`

It subscribes to:

- `metrics_collected`
- `function_tools_executed`
- `conversation_item_added`
- `user_input_transcribed`
- `session_usage_updated`
- `close`

And, when `ctx.add_shutdown_callback()` / `ctx.make_session_report()` are available, it flushes a session report on shutdown.

## Example

```python
from vent_livekit import instrument_livekit_agent

vent = instrument_livekit_agent(ctx=ctx, session=session)
```

If you have extra metadata that the outside room observer cannot already see, you can pass it explicitly:

```python
vent = instrument_livekit_agent(
    ctx=ctx,
    session=session,
    session_metadata={
        "provider_call_id": "pstn-call-123",
    },
    debug_urls={"insight": "https://..."},
)
```

## Notes

- This keeps `vent:*` as the internal wire format, but the user no longer needs to hand-author those messages.
- Transcript, room/session identity, and timing should still come from native LiveKit room signals (`lk.transcription`, `lk.agent.state`, room name/sid).
- For the Node.js equivalent, use `@vent-hq/livekit` (`npm install @vent-hq/livekit`).
