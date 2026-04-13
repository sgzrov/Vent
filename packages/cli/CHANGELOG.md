# vent-hq

All notable changes to `vent-hq` are documented in this file.

For the repo-wide summary, see [CHANGELOG.md](../../CHANGELOG.md).

## 0.9.14

### Notes

- Current published version.
- Detailed notes for releases between `0.8.29` and `0.9.14` were not backfilled.

## 0.8.29

### Changed

- Version-only CLI release.

## 0.8.0

### Added

- Inlined the full config schema into the Claude Code, Cursor, and Codex skill files so agents no longer need `npx vent-hq docs`.
- Auto-assigned free ports for local agents started with `start_command` to avoid collisions in parallel runs.
- Added formatted test results to SSE events, including `passed_tests` and `failed_tests`.

### Changed

- Removed the `docs` command now that the schema ships with the skill files.
- Routed debug logs to stderr so stdout stays clean for structured output.

### Fixed

- Emitted SSE events as JSON lines in non-TTY mode so coding agents no longer see empty or `undefined` output.
- Suppressed info and progress stderr output in non-TTY mode unless `--verbose` is set, keeping the final JSON summary clean for coding agents.
- Removed `.vent/last-run.log` and its shell workaround now that stdout is reliable.
- Added validation to ensure `run_id` exists after submit.
