# syntax=docker/dockerfile:1.7-labs
# api.metro.box — the hosted service: the vault and the server list on :8420.
# No station, no MCP, no gateway runs here; those live in the daemon a user runs on
# their own machine. No build step: it runs from source via `bun apps/api/src/server.ts`.
FROM oven/bun:1.4.0

WORKDIR /app

# Postgres over TLS needs the system cert store, which the oven/bun image ships without.
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

# METRO_HTTP_HOST=0.0.0.0 so the platform proxy can reach the app.
ENV HOME=/data \
    METRO_HTTP_HOST=0.0.0.0 \
    METRO_LOG_LEVEL=info

EXPOSE 8420
# CMD, not ENTRYPOINT: Fly release_command replaces CMD but ENTRYPOINT always runs, so an
# ENTRYPOINT here would make the release machine boot a SECOND server instead of
# running the migration, and never exit.
CMD ["bun", "/app/apps/api/src/server.ts"]
