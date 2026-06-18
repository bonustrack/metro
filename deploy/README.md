# Metro cloud deployment

The `Dockerfile` at the repo root builds a single image that runs the **Metro
daemon** (supervisor + trains + webhook/monitor HTTP+SSE API) co-located with the
**Streamable-HTTP MCP server**. Hosting target is deliberately left open — the
image is a plain Bun container, deployable to any platform that runs OCI images
(Fly, Render, Railway, ECS, a VM, …). Pick ingress + a persistent volume there.

## Build & run

```bash
docker build -t metro .
docker run --rm \
  -p 8420:8420 -p 8421:8421 \
  -v metro-data:/data \
  --env-file metro.env \
  metro
```

Ports: `8420` = daemon webhook + monitor API (POST /api/call, GET /api/tail,
GET /api/accounts, GET /health). `8421` = MCP Streamable HTTP (`POST /mcp`,
`GET /health`). Volume `/data` holds the XMTP MLS dbs, the outbox journal, and
history — keep it persistent so derived inboxes keep their installation identity.

## Config — ENV ONLY (no secrets on disk)

Secrets are injected at runtime; nothing secret is baked into the image.

XMTP (mnemonic-derived multi-account — see docs/cloud-mcp-refactor.md §3):
- `XMTP_MNEMONIC` (or `XMTP_MNEMONIC_FILE`) — root secret for HD derivation
- `XMTP_DERIVE_COUNT=N` — derive accounts `x0..x(N-1)` at indices `0..N-1`
- `XMTP_DERIVE_INDICES=0,3,7` — explicit indices (wins over count)
- `XMTP_ENV` — network (production/dev/local)
- `XMTP_PRIVATE_KEY` — legacy single-account alias

Discord (multi-bot):
- `DISCORD_BOT_TOKENS=tok1,tok2` (+ optional `DISCORD_BOT_IDS=alpha,beta`)
- `DISCORD_BOT_TOKEN` — legacy single-bot alias

Telegram (multi-bot):
- `TELEGRAM_BOT_TOKENS=tok1,tok2` (+ optional `TELEGRAM_BOT_IDS=...`)
- `TELEGRAM_BOT_TOKEN` — legacy single-bot alias

Daemon / MCP wiring:
- `METRO_MONITOR_TOKEN` — Bearer for the daemon HTTP API (REQUIRED; the MCP
  bridge uses it). Generate a strong random value.
- `METRO_MCP_HTTP_TOKEN` — optional Bearer gating the MCP `/mcp` endpoint itself.
- `METRO_WEBHOOK_PORT` (default 8420), `METRO_MCP_HTTP_PORT` (default 8421),
  `METRO_MCP_HTTP_HOST` (default 0.0.0.0).
- `METRO_MONITOR_HOSTS` — Host-header allowlist for the daemon API (the
  entrypoint defaults it to loopback for the in-container MCP bridge).

## Liveness

`GET /health` on **either** port returns JSON liveness. The daemon's
`/health` also lists configured accounts (PUBLIC identity only — XMTP/Discord/
Telegram ids, addresses, usernames; never tokens/keys/mnemonic). The image's
`HEALTHCHECK` probes the MCP server's `/health`.

## Transports

- **Cloud**: MCP over Streamable HTTP (`METRO_MCP_TRANSPORT=http`, the image
  default). Clients connect to `https://<host>/mcp`.
- **Local dev**: run `bun packages/metro/src/mcp/index.ts` with no `METRO_MCP_TRANSPORT`
  (defaults to stdio) for a single local Claude Code / Codex client.
