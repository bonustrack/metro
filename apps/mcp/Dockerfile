# syntax=docker/dockerfile:1.7-labs
# mcp.metro.box: the one MCP endpoint every agent uses for its organization connectors, on :8430.
# Build it from the repository root (the build context must hold every workspace manifest):
#   flyctl deploy . --config apps/mcp/fly.toml --dockerfile apps/mcp/Dockerfile
# No build step: it runs from source via `bun apps/mcp/src/server.ts`.
FROM oven/bun:1.4.0

WORKDIR /app

# Postgres over TLS and the HTTPS calls to connector vendors need the system cert store,
# which the oven/bun image ships without.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 1) Runtime deps only, cached unless a manifest or the lockfile changes. Every workspace
#    manifest is copied so Bun resolves the full workspace for the frozen install, exactly
#    as the api's root Dockerfile does.
COPY package.json bun.lock turbo.json ./
COPY --parents apps/*/package.json packages/*/package.json ./
COPY patches ./patches
# --filter installs only what @metro-labs/mcp and the packages it depends on need: no station
# SDK, no daemon, no drizzle-kit (migrations run from apps/api only).
RUN bun install --frozen-lockfile --production --filter @metro-labs/mcp

# 2) Only the sources this service runs.
COPY apps/mcp ./apps/mcp
COPY packages/core ./packages/core
COPY packages/http ./packages/http
COPY packages/connectors ./packages/connectors

ENV METRO_HTTP_HOST=0.0.0.0 \
    METRO_HTTP_PORT=8430 \
    METRO_LOG_LEVEL=info

EXPOSE 8430
CMD ["bun", "/app/apps/mcp/src/server.ts"]
