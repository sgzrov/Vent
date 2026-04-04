# AGENTS.md

## Build and Development Commands

This project uses **pnpm** (>=9.0.0) as the package manager and **Turbo** for monorepo orchestration. All commands run from the repository root.

### Installation
```bash
pnpm install                    # Install all dependencies
```

### Build & Dev
```bash
pnpm build                      # Build all packages and apps (Turbo)
pnpm dev                        # Watch mode with hot reload for all apps
pnpm typecheck                  # Run TypeScript type checking across all packages
pnpm clean                      # Remove all dist/ and .next/ outputs
```

### Database
```bash
pnpm db:generate                # Generate new Drizzle migration from schema changes
pnpm db:migrate                 # Run pending migrations against DATABASE_URL
```

### Deployment (Fly.io)
```bash
pnpm deploy:api                 # Deploy API to Fly.io
pnpm deploy:worker              # Deploy worker to Fly.io
pnpm deploy:dashboard           # Deploy dashboard to Fly.io
pnpm deploy:all                 # Deploy API first, then worker + dashboard in parallel
```

### CLI (published as `vent-hq`)
```bash
pnpm --filter vent-hq build     # Bundle CLI to dist/index.mjs
npx vent-hq init                # Bootstrap auth + install skill files + scaffold suite
npx vent-hq run <config>        # Run a single call and stream results
npx vent-hq agent start         # Start persistent relay session for local agent
npx vent-hq status <run-id>     # Check or stream run status
npx vent-hq login               # Device auth flow via browser
```

## Architecture Overview

### Core Concepts
- **Vent** gives coding agents (Claude Code, Cursor, Codex) the ability to call, hear, and evaluate voice AI agents. The coding agent uses Vent to make real calls against your agent, reads back results (transcripts, latency, audio quality, interruptions, tool calls), and adapts code and platform config based on what it observes. Designed to be used iteratively — describe what your voice agent should do, let the coding agent work, come back to a fully working agent.
- **Adapters** connect to agents on platforms (Vapi, Retell, LiveKit, ElevenLabs, Bland) or to custom endpoint / local agents (raw WebSocket via relay). Platform adapters require API keys, encrypted at rest with `PLATFORM_CONNECTIONS_MASTER_KEY`.

### Monorepo Structure
```
apps/
├── api/                    # Fastify HTTP API server (port 3000)
├── dashboard/              # Next.js 15 frontend (React 19, Tailwind, shadcn/ui)
└── worker/                 # BullMQ job processor (voice call execution)

packages/
├── adapters/               # Voice platform adapters
├── artifacts/              # S3/R2 artifact storage (recordings, audio)
├── cli/                    # Published CLI (vent-hq on npm)
├── db/                     # Drizzle ORM schema + PostgreSQL migrations
├── platform-connections/   # Platform credential encryption (AES-256-GCM)
├── relay-client/           # WebSocket relay for local agent tunneling
├── runner/                 # Call execution engine (orchestration, audio analysis)
├── shared/                 # Shared types, Zod schemas, constants, utilities
└── voice/                  # Voice processing (VAD, STT via Deepgram)
```

### Request Flow
Each `vent run` executes a single call. Run N calls in parallel via separate shell commands.

1. CLI submits call via `POST /runs/submit`
2. API validates config (Zod), checks usage limits, enqueues to per-user BullMQ queue
3. Worker picks up job, decrypts platform credentials, creates audio channel via adapter
4. Call executes with conversation turns, progress streams via HTTP callbacks to API
5. API broadcasts events via Redis pub/sub → SSE to CLI
6. Results stored and returned to the coding agent

### Key Files

| What                       | Where                                            |
|----------------------------|--------------------------------------------------|
| DB schema                  | `packages/db/src/schema.ts`                      |
| All types                  | `packages/shared/src/types.ts`                   |
| All Zod schemas            | `packages/shared/src/schemas.ts`                 |
| API routes                 | `apps/api/src/routes/*.ts`                       |
| Auth middleware             | `apps/api/src/plugins/auth.ts`                   |
| Queue middleware            | `apps/api/src/plugins/queue.ts`                  |
| Run submission logic        | `apps/api/src/lib/run-submit.ts`                 |
| Relay multiplexer           | `apps/api/src/routes/relay.ts`                   |
| Job processor               | `apps/worker/src/jobs/run-executor.ts`           |
| CLI entry                   | `packages/cli/src/index.ts`                      |
| CLI run command             | `packages/cli/src/commands/run.ts`               |
| Skill files (embedded)      | `packages/cli/src/skills/*.md`                   |
| Platform credential crypto  | `packages/platform-connections/src/index.ts`     |
| Result formatting           | `packages/shared/src/format-result.ts`           |

### Database
- **ORM:** Drizzle with PostgreSQL (`postgres` driver)
- **Tables:** runs, scenarioResults, accessTokens, platformConnections, artifacts, deviceSessions, agentSessions, runEvents
- **Migrations:** Sequential SQL files in `packages/db/drizzle/`
- **Auto-migrate on deploy:** fly.toml release_command runs `pnpm --filter @vent/db migrate`

### Build System
- **Bundler:** esbuild (custom `scripts/bundle.mjs` per app/package)
- **API/Worker:** CommonJS output targeting Node 20
- **CLI/Relay:** ESM output (.mjs) with code splitting
- **WASM:** ten-vad voice activity detection assets copied into dist/

### Deployment
- **Platform:** Fly.io (3 apps: vent-api, vent-worker, vent-dashboard)
- **API:** 2 min machines, 512MB, shared CPU. Health check at `/health`
- **Worker:** 1 machine, 2GB, performance CPU. No auto-stop
- **Dashboard:** 1 min machine, 256MB, standalone Next.js
- **CI/CD:** GitHub Actions → Changesets → npm publish for CLI

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis/Upstash for BullMQ + pub/sub
- `DASHBOARD_URL` — Frontend URL for CORS and device auth redirects
- `NEXT_PUBLIC_API_URL` — API URL for dashboard client-side requests
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI` — WorkOS OAuth callback URL
- `RUNNER_CALLBACK_SECRET` — HMAC secret for worker→API callbacks
- `RUNNER_PUBLIC_HOST`, `RUNNER_LISTEN_PORT` — Public SIP host/port for Bland/Twilio worker callbacks
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` — WorkOS auth
- `PLATFORM_CONNECTIONS_MASTER_KEY` — 32-byte hex key for encrypting platform credentials (`openssl rand -hex 32`)
- `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `HUME_API_KEY` — AI/voice providers
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — Twilio
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` — Cloudflare R2

## Code Style
- TypeScript strict mode, ES2022 target, Node.js >= 20
- Zod schemas for all API boundaries (`packages/shared/src/schemas.ts`)
- Types centralized in `packages/shared/src/types.ts`
## Commit Style
`type: description` — 8 words or fewer (excluding type prefix). Bisect commits: every commit is a single logical change. Split rename/refactor/feature/test into separate commits.

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
