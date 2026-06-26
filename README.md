# @metro-labs/mcp

> Bridge live chat — XMTP, Telegram, Discord, inbound webhooks — into an AI coding session as MCP tools.

Metro lets an AI coding agent (Claude Code) hold real conversations on chat
platforms while it works: inbound messages arrive in the session as events, and the
agent sends, replies, reacts, and manages channels through `mcp__metro__*` tools. It
runs as a single [Bun](https://bun.sh) process that serves the Model Context Protocol
over Streamable HTTP and supervises one subprocess per platform.

## The MCP tools

Every tool takes a `line` — a `metro://<station>/<path>` URI that identifies a
conversation and encodes its platform, so the server routes the call automatically.

| Tool | Purpose |
| --- | --- |
| `send` | Send a message — text and/or `attachments`, optional `reply_to` |
| `reply` | Reply to a `message_id` with text |
| `react` / `unreact` | Add / remove an emoji reaction |
| `edit` / `delete` | Edit or delete a message you sent |
| `read` | Read recent history for a conversation |
| `create_channel` / `dm` | Open an XMTP group or 1:1 DM |
| `group_info` / `add_members` / `remove_members` / `set_channel_metadata` / `close_channel` | Manage an XMTP group |
| `ask` | Post a poll (AskUserQuestion-style) on XMTP |
| `list_accounts` | List the configured bot / inbox identities |

Support varies by platform: webhook lines are inbound-only; XMTP has no `edit`/`delete`;
Telegram has no `read`. An unsupported verb returns the platform's reason rather than
failing silently.

## Stations

A **station** is a chat-platform integration:

- **xmtp** — end-to-end-encrypted DMs and groups. Identity is an Ethereum EOA, with
  multi-account support via an HD mnemonic. Runs on the XMTP production network.
- **telegram** — Bot API. One or many bots from a comma-separated token list.
- **discord** — bot gateway + REST. One or many bots.
- **webhook** — inbound HTTP receiver (GitHub, Intercom, …). Inbound-only; events
  arrive on `metro://webhook/<id>`.

## Running locally

```sh
bun install
cp .env.example .env     # configure at least one station
bun run start            # serves on http://127.0.0.1:8420
```

Stations run as subprocesses the supervisor spawns from `~/.metro/trains/*.{ts,js,mjs}`
(hot-reloaded). Add a one-line file per platform you want to run:

```ts
// ~/.metro/trains/xmtp.ts
import '@metro-labs/xmtp/train';
```

(The container image generates these automatically — see [Deploying](#deploying).)

## Deploying

[`Dockerfile`](Dockerfile) + [`docker-entrypoint.sh`](docker-entrypoint.sh) +
[`fly.toml`](fly.toml) + [`.dockerignore`](.dockerignore) run Metro on
[Fly.io](https://fly.io) as **one always-on machine + a single-attach volume**. The
volume attaches to only one machine, which enforces XMTP's **single-writer** rule for
free, and disk-backed deploys replace the machine in place — so there's never a moment
with two writers on the same inbox (which would corrupt MLS state). The entrypoint
generates a train per configured station and keeps state on the volume.

### 1. Create the app + volume

```sh
fly auth login                       # https://fly.io/docs/flyctl/install/
# edit app = "metro" in fly.toml to a unique name first
fly apps create <your-app-name>
fly volumes create metro_data --app <your-app-name> --region iad --size 10   # GB
```

One volume = one machine. Don't create a second volume/machine — XMTP forbids
concurrent writers.

### 2. Set secrets

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
internet-facing through Fly). `/health` stays public for Fly's health check.

### 3. Deploy

```sh
fly deploy --app <your-app-name>
fly logs --app <your-app-name>     # watch the stations boot
fly status --app <your-app-name>   # should show ONE machine, running
```

### 4. Custom domain + MCP client (optional)

```sh
fly certs add mcp.metro.box --app <your-app-name>
# then add the CNAME / A+AAAA records Fly prints, at your DNS provider

claude mcp add --transport http metro https://mcp.metro.box \
  --header "Authorization: Bearer <METRO_MCP_HTTP_TOKEN>"
# or the default host: https://<your-app-name>.fly.dev
```

### Persistence & operating notes

- **Live data** lives on the volume at `/data` (`HOME=/data`): XMTP MLS DBs under
  `/data/.metro/*.db3`, outbox/IPC under `/data/.cache/metro`. It survives restarts,
  deploys, and machine moves. A Fly volume is host-local SSD (durable, daily
  snapshots, 5-day default); for a real safety net add off-box backup (e.g. Litestream
  replicating the SQLite DBs to object storage — restoring rebuilds the *same* DB,
  costing 0 XMTP installation slots).
- **Keep it to one machine.** `fly scale count 1`. Two machines = two XMTP writers =
  corruption. The single-attach volume makes this hard to do by accident.
- **Always-on.** `auto_stop_machines = false` keeps the XMTP streams / Telegram
  long-poll alive. Don't enable autostop.
- **Memory.** Each XMTP account is a live client; bump `[[vm]] memory` in `fly.toml`
  (2gb+) as you add accounts.
- **Dev vs prod.** Use a *separate* MNEMONIC for testing — redeploys/restarts are safe
  (the DB persists), but creating fresh DBs elsewhere burns the inbox's
  10-installation / 256-update budget.

XMTP keeps each inbox's MLS state in a local SQLite database that **must persist**
(losing it re-installs the inbox), and only one instance may run per inbox. Metro is
therefore **single-writer**: one machine, one volume — don't scale past a single
instance, and don't run the same identity in two places.

## Configuration

All configuration comes from the environment (copy [`.env.example`](.env.example) →
`.env`). Configure at least one station.

### XMTP

| Var | Meaning |
| --- | --- |
| `MNEMONIC` | BIP-39 mnemonic the HD accounts derive from (`m/44'/60'/0'/0/<index>`) |
| `DERIVE_COUNT` | How many accounts to derive (ids `x0..xN`). Default `1` |

### Telegram / Discord

| Var | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKENS` | Comma list of bot tokens → one bot each (ids `t0..tN`) |
| `DISCORD_BOT_TOKENS` | Comma list of bot tokens → one bot each (ids `d0..dN`) |

Each bot is an account with its own id; lines are account-scoped
(`metro://telegram/<account>/<chat>`) so replies go back out the same identity.

### Server

| Var | Default | Meaning |
| --- | --- | --- |
| `METRO_CHANNEL_ALLOWLIST` | (built-in) | Comma list of sender ids allowed to drive the session; inbound from others is dropped. `*` disables gating (a prompt-injection surface). |
| `METRO_CHANNEL_STATIONS` | `xmtp,telegram,discord` | Stations surfaced to the MCP |
| `METRO_HTTP_HOST` | `127.0.0.1` | HTTP bind host; set `0.0.0.0` behind a platform proxy |
| `METRO_WEBHOOK_PORT` | `8420` | HTTP port |
| `METRO_MCP_HTTP_TOKEN` | — | Optional bearer gating the MCP endpoint; the same token also gates the Monitor transport (`/api/*`). Unset → Monitor disabled (404). |
| `METRO_LOG_LEVEL` | `info` | `trace`–`fatal`; logs go to stderr |

## Connecting a client

The HTTP server serves the **MCP at the root path** (so it can sit behind its own host,
e.g. `https://mcp.metro.box`), plus `GET /health` and the webhook receiver at
`/wh/<id>`. Register it:

```sh
claude mcp add --transport http metro https://mcp.metro.box \
  --header "Authorization: Bearer <METRO_MCP_HTTP_TOKEN>"
```

Metro is a Claude Code **channel** — it pushes inbound chat into a running session.
Start Claude Code with the channel flag:

```sh
claude --dangerously-load-development-channels server:metro
```

Inbound messages then arrive as `<channel source="metro" line="…" …>text</channel>`
events; the agent replies with the tools above, and tool-approval prompts relay to the
chat so you can answer from your phone. (Requires Claude Code v2.1.80+ and claude.ai or
Console API auth.)

### Monitor transport

The **Channel** above is the primary transport. The **Monitor** is an optional
second, lightweight live transport served on the same HTTP port for tools that
want to observe and drive Metro over plain HTTP (no MCP client needed). It is
**live-only by design** — no history, backlog, or replay — and can be attached
mid-session.

The Monitor reuses the MCP HTTP token: set `METRO_MCP_HTTP_TOKEN` to enable it,
and reach `/api/*` with the same `?token=<METRO_MCP_HTTP_TOKEN>` (or
`Authorization: Bearer`) as the MCP/Channel endpoint. While the token is unset
the `/api/*` surface stays disabled (returns 404), so there is no
unauthenticated surface.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/tail` | Server-Sent Events stream of live bus events from the moment of connection (25s keepalive). No replay. |
| `POST /api/call/:train/:action` | Invoke a station verb (`send`/`reply`/`react`/…) over HTTP; routes through the station registry and returns the dispatch result as JSON. |
| `GET /api/health` | `{ ok, service, version, uptime_s }` snapshot. |

Auth is `Authorization: Bearer <METRO_MCP_HTTP_TOKEN>` (or `?token=`):

```sh
curl -N -H "Authorization: Bearer $METRO_MCP_HTTP_TOKEN" http://127.0.0.1:8420/api/tail
curl -X POST -H "Authorization: Bearer $METRO_MCP_HTTP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"args":{"line":"metro://discord/1","text":"hi"}}' \
  http://127.0.0.1:8420/api/call/discord/send
```

## How it works

One process does everything:

- a **supervisor** spawns and multiplexes the station subprocesses,
- the **MCP** is served in the same process — the dispatcher publishes inbound
  events to an in-process event bus, the MCP's inbound relay subscribes and pushes
  `notifications/claude/channel`, and outbound dispatches straight to the stations.

Inbound is never journaled to disk: the dispatcher publishes each event to an
in-memory event bus ([`src/daemon/events.ts`](apps/mcp/src/daemon/events.ts)) and the
MCP relay subscribes to push channel notifications. The MCP HTTP transport is also
session-tolerant: it survives a daemon restart so connected sessions auto-resume.

**Lines.** Every conversation is a `metro://<station>/<path>` URI — the station is the
host, the path is platform-specific (account-scoped for multi-bot). One parser
([`src/stations/lines.ts`](apps/mcp/src/stations/lines.ts)) owns the scheme.

**Envelope.** Inbound and outbound events share one shape (`{kind?, id?, ts?, station?,
line, from?, to?, message_id?, text?, payload?, …}`, see
[`src/daemon/protocol.ts`](apps/mcp/src/daemon/protocol.ts)).

**State.** Metro is stateful and needs a persistent volume: the XMTP MLS databases under
`~/.metro/` and the IPC socket under `$METRO_STATE_DIR`
(default `~/.cache/metro`).

## Development

```sh
bun run build      # tsc -> dist/
bun run typecheck
bun run test
bun run lint
```

## Project structure

A bun-workspaces + turborepo monorepo: the core daemon lives in `apps/mcp`, and
each external messaging platform is a private station package under `packages/`.

```
apps/
  mcp/                  # @metro-labs/mcp — the core daemon (see apps/mcp/README.md)
    src/
      server.ts         # entry (bin: metro-daemon) — imports daemon/boot
      daemon/           # the supervised runtime: supervisor + dispatcher HTTP
                        #   (/health, /mcp, /wh/<id>) + IPC + event bus + paths/tunnel
      mcp/              # the MCP protocol surface (createMetroMcp) at the root path
      stations/         # the station contract + runtime + registry the core reads:
                        #   types.ts            — Station/StationTool/Verb contract
                        #   station-runtime.ts  — makeStation, CallMsg, emit/respond
                        #   account-store.ts    — multi-bot account store (csv, genIds)
                        #   attachments.ts      — saveBufferToCache, toCanonical, MIME
                        #   registry.ts         — the static list of station descriptors
                        #   lines.ts            — the metro:// Line parser

packages/               # private station packages — each implements the contract
  xmtp/                 #   imported from @metro-labs/mcp/stations/*
  telegram/             #   (see each package's README.md)
  discord/
  webhook/
```

The station contract and runtime live in the core (`apps/mcp/src/stations`) and are
re-exported via `@metro-labs/mcp/stations/*`; the platform packages depend only on
`@metro-labs/mcp` and stay isolated (e.g. the XMTP node SDK never enters the core graph).
See the per-package READMEs: [apps/mcp](apps/mcp/README.md),
[xmtp](packages/xmtp/README.md), [telegram](packages/telegram/README.md),
[discord](packages/discord/README.md), [webhook](packages/webhook/README.md).

## License

MIT
