# metro — one process (stations + outbox + webhooks + MCP) on :8420.
# Debian-based Bun image (glibc) so @xmtp/node-bindings loads the linux-x64-gnu
# binary. No build step: metro runs from source via `bun apps/mcp/src/server.ts`.
FROM oven/bun:1.3.9

WORKDIR /app

# The XMTP native (Rust) binding uses the SYSTEM cert store for its gRPC TLS, but the
# oven/bun image ships without ca-certificates — install them or XMTP can't connect.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 1) Runtime deps only (cached unless a manifest/lockfile changes). Bun transpiles
#    TS at runtime, so devDeps (tsc/eslint) are not needed in the image. Copy the
#    root workspace manifest + lockfile + turbo config + EVERY workspace manifest
#    (apps/mcp + all packages/*) so Bun resolves the full workspace and hoists the
#    @metro-labs/* symlinks before the rest of the source is copied. Missing a
#    station manifest here yields an incomplete install (unresolved workspace deps).
COPY package.json bun.lock turbo.json ./
COPY apps/mcp/package.json ./apps/mcp/package.json
COPY packages/xmtp/package.json ./packages/xmtp/package.json
COPY packages/telegram/package.json ./packages/telegram/package.json
COPY packages/discord/package.json ./packages/discord/package.json
COPY packages/webhook/package.json ./packages/webhook/package.json
RUN bun install --frozen-lockfile --production

# 2) App source. node_modules/.env/.git/dist are excluded via .dockerignore, so the
#    installed deps and your secrets are never copied over / baked in.
COPY . .
RUN chmod +x /app/docker-entrypoint.sh

# HOME=/data → ~/.metro (XMTP MLS DBs) and ~/.cache/metro (outbox/journal/IPC) live
# on the mounted volume. Train scripts are generated per configured station at boot.
# METRO_HTTP_HOST=0.0.0.0 so Fly's proxy can reach the app.
ENV HOME=/data \
    METRO_TRAINS_DIR=/app/trains \
    METRO_HTTP_HOST=0.0.0.0 \
    METRO_LOG_LEVEL=info

EXPOSE 8420
ENTRYPOINT ["/app/docker-entrypoint.sh"]
