# Multi-stage build for the Node API + worker (they share one image — 03_ARCHITECTURE §3.3).
# Build context is the repo root.
FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN pnpm --filter @varuna/shared build \
  && pnpm --filter @varuna/api build \
  && pnpm --filter @varuna/worker build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
