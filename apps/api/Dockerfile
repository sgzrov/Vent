FROM node:20-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/voice/package.json packages/voice/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/relay-client/package.json packages/relay-client/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/voice packages/voice
COPY packages/adapters packages/adapters
COPY packages/relay-client packages/relay-client
COPY apps/api apps/api
COPY tsconfig.json tsconfig.json
RUN pnpm --filter @vent/shared build
RUN pnpm --filter @vent/db build
RUN pnpm --filter @vent/voice build
RUN pnpm --filter @vent/adapters build
RUN pnpm --filter @vent/relay-client build
RUN pnpm --filter @vent/api build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app .
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
