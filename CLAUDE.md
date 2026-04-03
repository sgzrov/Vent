# Vent Agent Guidelines

## Testing Context

This is the Vent src repo. There is a separate test repo used for testing the Vent CLI against actual codebases. When logs, errors, or test output from integration tests are pasted here, they originate from that test repo.

## Workflow Orchestration

Important: PRODUCTION-ONLY fixes, no localhost.

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Use plan mode for verification steps, not just building
- Before planning, use web search and search up best practices and competitor (Hamming, Roark, Coval, etc) practices
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- `git diff` before/after; match your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Honest Elegance (balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky, "knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report, just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told to

## Task Management
- **Plan First**: Write plan to `tasks/plan.md` with checklist items
- **Verify Prereqs**: Check plan before starting implementation
- **Track Progress**: Mark items complete as you go
- **Validate Changes**: High-level summary at each step
- **Document Results**: Add review section to `tasks/plan.md`
- **Capture Lessons**: Update `tasks/lessons.md` after corrections
- **Backward Compatability**: Don't worry about backward compatability.

## Commit Messages

Use `type: small description` format for commits. Keep commit messages to 8 words or fewer (excluding the type prefix).

| Type       | When to use                                              |
|------------|----------------------------------------------------------|
| `feat`     | New user-facing feature                                  |
| `fix`      | Bug fix                                                  |
| `refactor` | Code restructuring (no feature or fix)                   |
| `perf`     | Performance improvement                                  |
| `docs`     | Documentation only                                       |
| `test`     | Add or modify tests only                                 |
| `chore`    | Maintenance (tooling, deps, scripts) — no runtime change |
| `build`    | Build system / deps affecting build output               |
| `ci`       | CI configuration changes                                 |
| `style`    | Formatting only (no logic change)                        |
| `revert`   | Revert a prior commit                                    |

## Pull Requests
- **Atomic commits**: Break changes into logical, self-contained commits. Don't lump all branch changes into a single commit with one message.
- Each commit should represent one coherent change (e.g., separate "refactor: extract helper" from "feat: add new endpoint").
- Commit as you go during implementation, not all at once at the end.

## Bisect Commits
Always bisect commits. Every commit should be a single logical change. When you've made multiple changes (e.g., a rename + a rewrite + new tests), split them into separate commits before pushing. Each commit should be independently understandable and revertable.

Examples of good bisection:
- Rename/move separate from behavior changes
- Test infrastructure (touchfiles, helpers) separate from test implementations
- Template changes separate from generated file regeneration
- Mechanical refactors separate from new features

When the user says "bisect commit" or "bisect and push," split staged/unstaged changes into logical commits and push.

## Design Context

### Users
Developers building voice AI agents who use coding agents (Claude Code, Cursor). They use the Vent CLI — installed via `vent init`, invoked by coding agent skill files. They're technical, time-constrained, and care about test results, not UI chrome. They visit the dashboard to review run results, compare baselines, and manage API keys.

### Brand Personality
**Bold, Innovative, Cutting-edge.** Vent is a new category — CI/CD for voice agents — and the brand should reflect that pioneering position. The tone is confident and direct, never corporate or hand-wavy.

### Emotional Goal
**Calm clarity.** When developers land on the dashboard, everything should feel organized and immediately scannable. No cognitive overhead. Status is obvious, results are front-and-center, navigation is minimal.

### Aesthetic Direction
- **Reference:** ElevenLabs — bold hero sections, clean product UI, confident typography, generous whitespace
- **Anti-reference:** Enterprise bloatware (Salesforce, ServiceNow) — no sidebar forests, no tabs-within-tabs, no information overload
- **Theme:** Support both light and dark mode, defaulting to system preference
- **Color palette:** Neutral zinc base. No accent color — let the semantic status colors (green/pass, red/fail, yellow/queued, blue/running) provide the only color in the UI
- **Typography:** Inter. Bold headings, muted secondary text. Monospace for IDs, hashes, and code
- **Spacing:** Generous. Prefer whitespace over density

### Design Principles
1. **Scannable over decorative** — Every pixel should help the developer understand test results faster. No ornamental UI.
2. **Status through color** — Green, red, yellow, blue are reserved exclusively for semantic status. The rest of the UI stays neutral.
3. **Progressive disclosure** — Show summary first (run list → run detail → scenario → trace). Don't front-load complexity.
4. **Developer-native** — Monospace where appropriate, keyboard-friendly, no marketing fluff in the product UI.
5. **Confident minimalism** — Bold typography and whitespace over borders and backgrounds. If a section feels cluttered, remove elements rather than adding separators.

## Default UI/Frontend Behavior
For any UI/frontend work, follow Impeccable's `frontend-design` skill and its anti-patterns by default.
Before finalizing UI changes, do a quick internal pass equivalent to: audit → normalize → polish (no need to ask me to run slash commands).

