FROM node:20-slim AS base
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
# crane for OCI image manipulation (builder mode appends node_modules layer without Docker daemon)
RUN curl -fsSL "https://github.com/google/go-containerregistry/releases/download/v0.21.1/go-containerregistry_Linux_x86_64.tar.gz" \
    -o /tmp/crane.tar.gz && tar xzf /tmp/crane.tar.gz -C /usr/local/bin crane && rm /tmp/crane.tar.gz

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/voice/package.json packages/voice/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY apps/runner/package.json apps/runner/package.json
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/runner apps/runner
COPY tsconfig.json tsconfig.json
RUN pnpm --filter @vent/shared build
RUN pnpm --filter @vent/voice build
RUN pnpm --filter @vent/adapters build
RUN pnpm --filter @vent/runner build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app .
CMD ["node", "apps/runner/dist/index.js"]
