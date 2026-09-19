# Build the Vite SPA, serve the static build with nginx. Build context is the repo root.
FROM node:20-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# In local docker-compose the browser reaches the API and TiTiler on the host ports, not
# the compose network names. Baked into the bundle at build time (only VITE_-prefixed vars
# are exposed — 11_API_KEYS §11.9.1). The nginx CSP already whitelists these origins.
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm install --frozen-lockfile=false \
  && pnpm --filter @varuna/shared build \
  && pnpm --filter @varuna/web build

FROM nginx:alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
