---
"vent-hq": minor
---

Inline full config schema into SKILL.md files, auto-assign ports for parallel local runs

- Inline full config schema (with XML tags) into all three skill files (claude-code, cursor, codex) so agents no longer need to run `npx vent-hq docs`
- Remove `docs` command — schema is now embedded in skill files
- Auto-assign free ports for local agents (`start_command`) so parallel test runs don't collide
- Add defensive output for missing test results (prevents "undefined" in output)
- Validate `run_id` exists after submit
