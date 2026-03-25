FROM node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/voice/package.json packages/voice/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/voice packages/voice
COPY packages/adapters packages/adapters
COPY apps/runner apps/runner
COPY apps/worker apps/worker
COPY tsconfig.json tsconfig.json
RUN pnpm --filter @vent/shared build
RUN pnpm --filter @vent/db build
RUN pnpm --filter @vent/voice build
RUN pnpm --filter @vent/adapters build
RUN pnpm --filter @vent/runner build
RUN pnpm --filter @vent/worker build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app .
CMD ["node", "apps/worker/dist/index.js"]
