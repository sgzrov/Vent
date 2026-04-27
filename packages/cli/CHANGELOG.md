# vent-hq

## 0.12.1

### Patch Changes

- 4936379: - Ctrl+C / SIGTERM now fires `POST /runs/:id/stop` and waits for it before exiting; the worker actually hangs up the platform call.
  - `init` flow rewritten: GitHub auto-auth via `gh` token, browser sign-in (WorkOS device flow) fallback. Anonymous bootstrap removed.
  - Run summary JSON now exposes top-level `status`, `passed`, `failed` so coding agents don't have to recompute from `calls[]`.
  - Skill files updated: corrected JSON field names (was `metrics.latency_p50_ms`, now `latency.response_time_ms`), tighter transcript/STT guidance, brief-by-default reporting rule.
  - CLI source typecheck fixes (resolvedRemotePlatform, RunSummaryJsonOptions, sse.ts ReadableStreamReadResult, auth.ts JSON typing).
  - `@vent/relay-client` ships hand-written `.d.ts` so consumers compile cleanly without the source's browser-globals.

## 0.10.1

### Patch Changes

- 5a02a64: Warn coding agents not to hand-roll `vent:session-report` for LiveKit agents. The skill files now flag that seeing the event in the WebSocket-mode examples does not authorize publishing it manually from a LiveKit agent — `ctx.addShutdownCallback` runs after `room.disconnect()` and the publish fails with "engine is closed". In LiveKit mode only publish what the helper explicitly supports.

## 0.9.19

### Patch Changes

- Auto-approve vent-hq Bash commands in .claude/settings.json to enable parallel execution

## 0.9.18

### Patch Changes

- Fix parallel execution: use single shell command with & instead of separate tool calls

## 0.9.17

### Patch Changes

- Move parallel execution to Critical Rules so coding agents never run calls sequentially

## 0.9.16

### Patch Changes

- Instruct coding agents to run multiple calls in parallel instead of sequentially

All notable changes to `vent-hq` are documented in this file.

For the repo-wide summary, see [CHANGELOG.md](../../CHANGELOG.md).

## 0.9.15

### Fixed

- Ensured npm publishes a freshly built CLI bundle by running `clean` and `build` during `prepack`.

### Changed

- Added canonical changelog metadata for the published `vent-hq` package.

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
