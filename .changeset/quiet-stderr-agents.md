---
"vent-hq": patch
---

Suppress stderr noise for coding agents

- Gate `printInfo`, `printSuccess`, `printWarn`, and per-test progress (`✔`/`✘`) behind `isTTY || --verbose`
- Coding agents (Claude Code, Cursor) merge stdout+stderr — stderr progress lines were polluting agent context windows
- In non-TTY mode without `--verbose`, the only output is the final pretty-printed JSON summary
