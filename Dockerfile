# Metro cloud image: the daemon (supervisor + trains + HTTP/SSE API) co-located
# with the Streamable-HTTP MCP server. Runs on Bun. All config via env; secrets
# (XMTP mnemonic, Discord/Telegram bot tokens) are injected at runtime — NOTHING
# secret is baked into the image. See deploy/README.md for the env contract.
FROM oven/bun:1.3.9

# Native deps some XMTP / node bindings need at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates bash \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install workspace deps first (better layer caching). Copy the lockfile + every
# package manifest, then install the whole workspace.
COPY package.json bun.lock turbo.json ./
COPY packages/metro/package.json packages/metro/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN bun install --frozen-lockfile

# Source. Bun runs the TS directly (no separate build step needed to boot).
COPY . .

RUN chmod +x deploy/entrypoint.sh

# Persistent state (XMTP MLS dbs, outbox journal, history) belongs on a volume.
VOLUME ["/data"]
ENV METRO_STATE_DIR=/data/cache \
    METRO_TRAINS_DIR=/app/deploy/trains \
    METRO_WEBHOOK_PORT=8420 \
    METRO_MCP_TRANSPORT=http \
    METRO_MCP_HTTP_PORT=8421

# 8420 = daemon webhook + monitor HTTP/SSE API; 8421 = MCP Streamable HTTP.
EXPOSE 8420 8421

# Liveness: the MCP server's public /health (no auth, no secrets).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.METRO_MCP_HTTP_PORT||8421)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./deploy/entrypoint.sh"]
