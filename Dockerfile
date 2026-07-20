# syntax=docker/dockerfile:1.7-labs
# metro — one process (stations + webhooks + MCP) on :8420.
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
#    (apps/* + packages/*) so Bun resolves the full workspace and hoists the
#    @metro-labs/* symlinks before the rest of the source is copied. The
#    `COPY --parents` glob (BuildKit/dockerfile:1.7-labs) preserves each manifest's
#    path and matches new workspace packages automatically, so adding a station can
#    never again silently break the frozen install / Fly auto-deploy.
COPY package.json bun.lock turbo.json ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN bun install --frozen-lockfile --production

# 2) App source. node_modules/.env/.git/dist are excluded via .dockerignore, so the
#    installed deps and your secrets are never copied over / baked in.
COPY . .

# HOME=/data → ~/.metro (XMTP MLS DBs) and ~/.cache/metro (state dir) live on the
# mounted volume. METRO_TRAINS_DIR sits under apps/mcp so the boot-generated train
# stubs resolve @metro-labs/* from apps/mcp/node_modules with no symlink.
# METRO_HTTP_HOST=0.0.0.0 so the platform proxy can reach the app.
ENV HOME=/data \
    METRO_TRAINS_DIR=/app/apps/mcp/trains \
    METRO_HTTP_HOST=0.0.0.0 \
    METRO_LOG_LEVEL=info

EXPOSE 8420
ENTRYPOINT ["bun", "/app/apps/mcp/src/server.ts"]
