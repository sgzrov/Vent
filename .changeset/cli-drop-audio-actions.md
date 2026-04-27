---
"vent-hq": minor
---

- **Breaking:** Removed `audio_actions` from the suite call spec (and from the result JSON's `audio_actions` field). The four action types (`interrupt`, `inject_noise`, `split_sentence`, `noise_on_caller`) tested platform configuration knobs (barge-in thresholds, noise filtering, endpointing) rather than agent code, so the metrics weren't actionable. Use `caller_audio.noise` for global noisy-line tests, and shape pacing via `caller_prompt`.
- **Breaking:** Removed `persona.interruption_style`. The autonomous mid-turn interruption planner that powered it has been removed too — caller behavior is now driven entirely by the system prompt + `caller_prompt`.
- Added `packages/cli/README.md` for the npm landing page (install, quickstart, sample suite, JSON output shape, per-platform notes).
- Refreshed Claude Code / Cursor / Codex skill files: dropped all `audio_actions` and `interruption_style` references and examples.
- Caller system prompt: tightened `wait` mode (now restricted to mid-utterance / tool calls / explicit "one moment") and added a goal-focus rule so the caller stops inventing stall tactics like "let me check with my team" once its objective is reachable or unreachable.
