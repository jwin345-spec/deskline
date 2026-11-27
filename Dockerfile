# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-alpine

# --- Dependencies ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- Build: Next.js standalone output ------------------------------------------
# Also the `tools` image used by docker-compose for one-off tasks (seeding).
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Runtime --------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app

# tini reaps zombies and forwards SIGTERM to Node. An SLA job interrupted by a
# shutdown is safe: its lease expires and another worker re-claims it.
RUN apk add --no-cache tini

# Files stay root-owned and therefore read-only for the unprivileged `node` user.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/migrations ./migrations

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/healthz" > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
