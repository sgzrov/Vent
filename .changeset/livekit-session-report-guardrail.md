---
"vent-hq": patch
---

Warn coding agents not to hand-roll `vent:session-report` for LiveKit agents. The skill files now flag that seeing the event in the WebSocket-mode examples does not authorize publishing it manually from a LiveKit agent — `ctx.addShutdownCallback` runs after `room.disconnect()` and the publish fails with "engine is closed". In LiveKit mode only publish what the helper explicitly supports.
