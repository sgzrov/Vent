# vent-hq

## 0.8.0

### Minor Changes

- 5a2d26e: Inline full config schema into SKILL.md files, fix "undefined" stdout for coding agents

  - Inline full config schema (with XML tags) into all three skill files (claude-code, cursor, codex) so agents no longer need to run `npx vent-hq docs`
  - Remove `docs` command — schema is now embedded in skill files
  - Auto-assign free ports for local agents (`start_command`) so parallel test runs don't collide
  - Fix "undefined" output: write every SSE event as JSON line to stdout in non-TTY mode (coding agents never see empty stdout)
  - Remove file logging (`.vent/last-run.log`) — no longer needed now that stdout always has output
  - Remove `; cat .vent/last-run.log` workaround from all skill files
  - Debug logs (`[vent ...]`) now write to stderr only, keeping stdout clean for structured output
  - Include formatted test result in SSE events for rich CLI output (intent scores, latency)
  - Add `passed_tests`/`failed_tests` to `run_complete` event metadata
  - Validate `run_id` exists after submit
