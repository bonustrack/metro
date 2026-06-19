# @metro-labs/metro

> Event-interception wire for live chat streams into AI coding sessions, exposed as a **stateless root MCP server**.

Metro bridges real chat platforms — XMTP, Telegram, Discord, and inbound webhooks —
into an AI coding session as Model Context Protocol tools. It is a **single package
at the repository root** (no monorepo, no CLI, no Docker). There are two entries:

- **MCP server** (`metro-channel`, [`src/mcp/index.ts`](src/mcp/index.ts)) — the
  primary entry. It surfaces Metro chat to an MCP client (Claude Code, Codex, …) as
  `mcp__metro__*` tools over **Streamable HTTP**. It is
  **stateless**: all config and secrets come from the environment and it reads/writes
  no state files (the only filesystem reads are inbound attachment paths handed to it
  in a tool call). Exposes `GET /health` (no auth) plus the MCP tool surface.
- **Daemon** (`metro-daemon`, [`src/server.ts`](src/server.ts)) — supervises the
  per-platform "station" subprocesses, multiplexes the JSON events they emit onto a
  single stream, runs the durable outbox, and serves the webhook receiver. The daemon
  keeps a small amount of local state on disk — see [State & volumes](#state--volumes).

Metro requires the [Bun](https://bun.sh) runtime.

## The MCP tool surface

The MCP server exposes these `mcp__metro__*` tools. Each takes a `line` (a
`metro://<station>/<path>` URI identifying a conversation); the line encodes its
station, so the server routes the call to the right station automatically.

| Tool | Purpose |
| --- | --- |
| `mcp__metro__send` | Send a message (text and/or `attachments`, optional `reply_to`) |
| `mcp__metro__reply` | Reply to a `message_id` with text |
| `mcp__metro__react` | Add an emoji reaction to a `message_id` |
| `mcp__metro__unreact` | Remove an emoji reaction |
| `mcp__metro__edit` | Edit a previously sent message |
| `mcp__metro__delete` | Delete a message |
| `mcp__metro__read` | Read recent history for a line |
| `mcp__metro__create_channel` | Create a channel/group (XMTP) |
| `mcp__metro__set_channel_metadata` | Set channel name / description / GitHub URL / labels |

Station support varies: webhook lines accept no outbound; XMTP has no `edit`/`delete`;
Telegram has no `read` — the tool returns the daemon's reason when a verb is
unsupported on a station.

## Supported stations

- **xmtp** — end-to-end-encrypted DMs and groups. Identity is an Ethereum EOA;
  multi-account via an HD mnemonic or raw keys (see [XMTP identity](#xmtp-identity)).
- **telegram** — Bot API. One or many bots via comma-separated tokens.
- **discord** — bot gateway + REST. One or many bots via comma-separated tokens.
- **webhook** — inbound HTTP receiver (e.g. GitHub, Intercom). Inbound-only; events
  arrive on `metro://webhook/<id>`.

## Configuration (environment only)

Both entries take **all** configuration from the environment — no config files are
required. Copy [`.env.example`](.env.example) to `.env` and fill in the stations you
want. Configure at least one station.

### XMTP identity

The XMTP station derives its account(s) from a **BIP-39 mnemonic** and always runs
on the production XMTP network.

| Var | Meaning |
| --- | --- |
| `MNEMONIC` | BIP-39 mnemonic the HD accounts derive from (`m/44'/60'/0'/0/<index>`) |
| `DERIVE_COUNT` | How many HD accounts to derive (indices `0..N-1`). Default `1` |

If `MNEMONIC` is unset the daemon exits with a clear error. Accounts derive at indices
`0..DERIVE_COUNT-1` with ids `x0..xN`. For richer setups, a `~/.metro/xmtp-accounts.json`
file (path overridable via `XMTP_ACCOUNTS_FILE`) lists accounts explicitly — each entry
sets a `derive` index.

### Multi-bot Discord / Telegram

Both bot stations accept a **comma-separated list of tokens** and start one bot
instance per token. Values are trimmed, deduped, and empties dropped.

| Var | Meaning |
| --- | --- |
| `DISCORD_BOT_TOKENS` | Comma list of Discord bot tokens → one bot each (ids `d0..dN`) |
| `TELEGRAM_BOT_TOKENS` | Comma list of Telegram bot tokens → one bot each (ids `t0..tN`) |

Each bot is an **account** with its own id. Inbound events are tagged with the
account they belong to, and lines are account-scoped —
`metro://discord/<account>/<channelId>`, `metro://telegram/<account>/<chatId>` — so
routing and replies always go back out the same bot identity.

Optional per-station controls: `*_ACCOUNTS_FILE` (explicit accounts JSON),
`*_ONLY_ACCOUNTS` (allowlist a subset of file accounts), and the
`*_LEGACY_DEFAULT_LINES` toggles.

### MCP server env

| Var | Default | Meaning |
| --- | --- | --- |
| `METRO_MONITOR_TOKEN` | — (REQUIRED) | Bearer for the daemon HTTP API the bridge calls |
| `METRO_BASE_URL` | `http://127.0.0.1:8420` | Daemon webhook/monitor HTTP base |
| `METRO_CHANNEL_ALLOWLIST` | (built-in) | Comma list of allowed sender ids; `*` disables gating (unsafe) |
| `METRO_CHANNEL_STATIONS` | `xmtp,telegram,discord` | Stations to surface (`webhook` always excluded) |
| `METRO_MCP_HTTP_PORT` | `8421` | Streamable-HTTP port |
| `METRO_MCP_HTTP_HOST` | `0.0.0.0` | Streamable-HTTP bind host |
| `METRO_MCP_HTTP_TOKEN` | — (off) | Optional bearer gating `POST /mcp` |

### Logging

`METRO_LOG_LEVEL` — one of `trace|debug|info|warn|error|fatal` (default `info`).
Logs go to stderr.

## Running

Run both entries directly with Bun — no Docker, no argv parsing.

```sh
# 1) the daemon (stations + outbox + webhook receiver)
bun src/server.ts

# 2) the MCP server — Streamable HTTP (hostable, multi-client, behind a load balancer)
METRO_MCP_HTTP_PORT=8421 \
METRO_MONITOR_TOKEN=... METRO_BASE_URL=http://127.0.0.1:8420 \
  bun src/mcp/index.ts
# liveness : GET  http://<host>:8421/health   (no auth, no secrets)
# MCP      : POST http://<host>:8421/mcp       (optional METRO_MCP_HTTP_TOKEN bearer)
```

## State & volumes

The **MCP server is stateless**. The **daemon is not**, and the XMTP station in
particular needs a **persistent local volume**:

- **XMTP MLS encryption databases** — the node SDK stores each account's MLS group
  state in a SQLite DB under `~/.metro/` (`xmtp-<env>-<id>.db3`, path overridable per
  account via `dbPath`). These must persist: losing them re-installs the inbox and
  drops decryption keys for existing groups.
- **Outbox / journal / IPC** under `$METRO_STATE_DIR` (default `~/.cache/metro`) — the
  durable outbox (at-least-once outbound delivery), the append-only history journal,
  the line/bot caches, the IPC unix socket, and the singleton lockfile.

This persistent volume is the accepted design for the daemon: the supervisor/transport
role is inherently stateful even though the *server* is not. Mount a durable volume at
`~/.metro` (and `$METRO_STATE_DIR`) when deploying. All secrets still come from env.

## The Line scheme

Every conversational scope is a **Line** — an opaque URI `metro://<station>/<path>`.
The station (`discord`, `telegram`, `xmtp`, `webhook`, …) is the host; the path is
station-specific (account-scoped for multi-bot). A single typed `Line` parser
([`src/lines.ts`](src/lines.ts)) owns the whole scheme.

## The event envelope

Inbound and outbound events share one shape (`Envelope` in
[`src/define-train.ts`](src/define-train.ts)): `{kind?, id?, ts?, station?, line,
line_name?, from?, from_name?, to?, message_id?, reply_to?, is_private?, text?,
emoji?, payload?, account?}`. Stations emit via `ctx.emit` / `ctx.emitInbound` /
`ctx.emitOutbound`; the daemon stamps `id`/`ts`/`station` when missing and routes the
result onward.

## Development

A single Bun package — no workspaces.

```sh
bun install
bun run build      # tsc -> dist/
bun run typecheck  # daemon (tsconfig.json) + MCP entry (tsconfig.mcp.json)
bun run test       # tsc + bun test
bun run lint       # eslint
```

## Project structure

```
src/
  mcp/            # the MCP server (primary entry: src/mcp/index.ts) — stateless
  server.ts       # daemon entry (re-exports dispatcher.ts)
  dispatcher*.ts  # dispatcher boot + outbound routing + webhook attribution
  trains/         # station supervisor + the station<->daemon protocol
  stations/       # built-in stations (xmtp, telegram, discord) + account loaders
  broker/         # claims + history streaming between daemon and clients
  codex-rc/       # codex bridge (protocol, client)
  registry*.ts    # the verb registry (single source of truth) + types
  sessions.ts     # sessions.json binding layer
  lines.ts        # the typed metro:// Line parser
  schema.ts       # the metro-call validator
  define-train.ts # public helper for authoring stations
```

## License

MIT
