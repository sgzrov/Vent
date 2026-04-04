@AGENTS.md

## Workflow

**PRODUCTION-ONLY fixes. No localhost.**

- **Plan first** — Enter plan mode for non-trivial tasks (3+ steps or architectural decisions). Web search best practices before planning. If something goes sideways, stop and re-plan.
- **Subagents** — Use liberally. One task per subagent. Offload research, exploration, and parallel analysis to keep main context clean.
- **Self-improvement** — After any correction, update `tasks/lessons.md`. Review lessons at session start.
- **Verify before done** — Prove it works: `git diff`, run checks, check logs. "Would a staff engineer approve this?"
- **Elegant, not hacky** — For non-trivial changes, ask "is there a more elegant way?" Skip for simple fixes.
- **Autonomous bug fixing** — When given a bug, just fix it. Zero hand-holding. Fix failing CI without being asked.
- **Task tracking** — Plan to `tasks/plan.md` with checklist. Mark items complete as you go. Don't worry about backward compatibility.
