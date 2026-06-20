# Deploying metro on Fly.io

metro runs as **one always-on machine + a single-attach volume**. The volume can
attach to only one machine, which enforces XMTP's **single-writer** rule for free,
and disk-backed deploys replace the machine in place — so there's never a moment with
two writers on the same inbox (which would corrupt MLS state).

Files: [`Dockerfile`](Dockerfile), [`docker-entrypoint.sh`](docker-entrypoint.sh),
[`fly.toml`](fly.toml), [`.dockerignore`](.dockerignore).

## 1. Prerequisites

```sh
# https://fly.io/docs/flyctl/install/
fly auth login
```

## 2. Create the app + volume

Edit `app = "metro"` in [`fly.toml`](fly.toml) to a unique name, then:

```sh
fly apps create <your-app-name>
fly volumes create metro_data --app <your-app-name> --region iad --size 10   # GB
```

One volume = one machine. Don't create a second volume/machine — XMTP forbids
concurrent writers.

## 3. Set secrets

Secrets live in Fly, never in `fly.toml` or the image:

```sh
fly secrets set --app <your-app-name> \
  MNEMONIC="your twelve word ..." \
  TELEGRAM_BOT_TOKENS="123:abc,456:def" \
  METRO_MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
# optional: DISCORD_BOT_TOKENS, and METRO_CHANNEL_ALLOWLIST to allow
# Telegram/Discord sender ids (default allowlist is XMTP-only; "*" = allow all).
```

`METRO_MCP_HTTP_TOKEN` gates the public `/mcp` endpoint — set it (the app is
internet-facing through Fly). `/health` stays public for Fly's health check; the
`/api/*` monitor endpoints are host-gated off by default.

## 4. Deploy

```sh
fly deploy --app <your-app-name>
fly logs --app <your-app-name>     # watch the stations boot
fly status --app <your-app-name>   # should show ONE machine, running
```

You should see `webhook + monitor + mcp ready` and `xmtp[x0] ready` / `telegram
train ready`.

## 5. Custom domain (optional)

```sh
fly certs add mcp.metro.box --app <your-app-name>
# then add the CNAME / A+AAAA records Fly prints, at your DNS provider
```

## 6. Connect an MCP client

```sh
claude mcp add --transport http metro https://mcp.metro.box \
  --header "Authorization: Bearer <METRO_MCP_HTTP_TOKEN>"
# or the default host: https://<your-app-name>.fly.dev
```

## Persistence & backup

- **Live data** lives on the volume at `/data` (`HOME=/data`): XMTP MLS DBs under
  `/data/.metro/*.db3`, outbox/journal/IPC under `/data/.cache/metro`. It survives
  restarts, deploys, and machine moves.
- **Caveat:** a Fly volume is host-local SSD — durable, but if that host's hardware
  dies the volume can be lost. Fly takes daily snapshots (5-day default). For a real
  safety net, add **off-box backup** (below) — restoring rebuilds the *same* DB, so
  it costs **0** XMTP installation slots.

### Optional: Litestream → object storage (Tigris / R2 / Spaces)

Continuously replicate the SQLite DBs off-box. In the `Dockerfile`, install the
litestream binary, and change the entrypoint's last line to run metro *under* it:

```sh
# instead of: exec bun /app/src/server.ts
exec litestream replicate -exec "bun /app/src/server.ts"
```

`litestream.yml` (one `dbs:` entry per account — `x0`, `x1`, …):

```yaml
dbs:
  - path: /data/.metro/xmtp-production-x0.db3
    replicas:
      - type: s3
        endpoint: https://fly.storage.tigris.dev   # or R2 / Spaces endpoint
        bucket: ${LITESTREAM_BUCKET}
        path: xmtp-x0
        access-key-id: ${LITESTREAM_ACCESS_KEY_ID}
        secret-access-key: ${LITESTREAM_SECRET_ACCESS_KEY}
```

On a fresh machine, `litestream restore` each DB before starting metro.

## Operating notes

- **Keep it to one machine.** `fly scale count 1`. Never scale up — two machines = two
  XMTP writers = corruption. (The volume makes this hard to do by accident.)
- **Always-on.** `auto_stop_machines = false` keeps the XMTP streams / Telegram
  long-poll alive. Don't enable autostop.
- **Memory.** Each XMTP account is a live client; bump `[[vm]] memory` in `fly.toml`
  (2gb+) as you add accounts.
- **Dev vs prod.** Use a *separate* MNEMONIC for testing — redeploys/restarts here are
  safe (the DB persists), but creating fresh DBs elsewhere burns the inbox's
  10-installation / 256-update budget.
