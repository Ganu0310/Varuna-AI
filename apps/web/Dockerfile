# Build the Vite SPA, serve the static build with nginx. Build context is the repo root.
FROM node:20-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm install --frozen-lockfile=false \
  && pnpm --filter @varuna/shared build \
  && pnpm --filter @varuna/web build

FROM nginx:alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
