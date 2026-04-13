# @vent-hq/livekit

Thin helper for forwarding LiveKit Agents SDK observability into Vent.

## Install

```bash
npm install @vent-hq/livekit
```

## What it does

`instrumentLiveKitAgent()` automatically publishes the existing `vent:*` topics that the Vent LiveKit adapter already understands:

- `vent:metrics`
- `vent:function-tools-executed`
- `vent:conversation-item`
- `vent:user-input-transcribed`

It subscribes to:

- `metrics_collected`
- `function_tools_executed`
- `conversation_item_added`
- `user_input_transcribed`
- `close`

It does not mirror room-visible signals or redundant derived events:

- no transcript forwarding
- no agent-state timing forwarding
- no room/session ID mirroring
- no separate transfer stream when handoffs can be derived from the forwarded LiveKit events

## Example

```ts
import { instrumentLiveKitAgent } from "@vent-hq/livekit";

const vent = instrumentLiveKitAgent({
  ctx,
  session,
});
```

If you are not using the room from `ctx`, you can also pass `room` or `participant` directly.

If you have extra metadata that the outside room observer cannot already see, you can pass it explicitly:

```ts
const vent = instrumentLiveKitAgent({
  ctx,
  session,
  sessionMetadata: {
    provider_call_id: "pstn-call-123",
    provider_debug_urls: { insight: "https://..." },
  },
});
```

## Notes

- This keeps `vent:*` as the internal wire format, but the user no longer needs to hand-author those messages.
- Transcript, room/session identity, and timing should still come from native LiveKit room signals (`lk.transcription`, `lk.agent.state`, room name/sid).
- For the Python equivalent, use `vent-livekit` (`pip install vent-livekit`).
