# @metro-labs/metro

> Event-interception wire for live chat streams into AI coding sessions, served as a **single-process MCP server**.

Metro bridges real chat platforms — XMTP, Telegram, Discord, and inbound webhooks —
into an AI coding session as Model Context Protocol tools. It is a **single package at
the repository root** (no monorepo, no CLI, no Docker) that runs as **one process**: a
daemon that supervises the per-platform "station" subprocesses, runs the durable
outbox and webhook receiver, and **serves the MCP surface in-process** on the same
HTTP server. Inbound chat reaches the MCP straight off the in-process history tail;
outbound tool calls go straight to the stations over the in-process IPC — there is no
HTTP bridge between the two and no shared secret to configure.

Metro requires the [Bun](https://bun.sh) runtime.

## Running

```sh
bun run start   # one process: stations + outbox + webhooks + MCP, on http://127.0.0.1:8420
```

That's the whole thing — one process, one port, configuration from the environment
only (copy [`.env.example`](.env.example) → `.env` and configure at least one station).

The single HTTP server (default `127.0.0.1:8420`, override `METRO_WEBHOOK_PORT`) serves:

| Path | Purpose |
| --- | --- |
| `/` (`/mcp` alias) | the **MCP** endpoint — `POST` = JSON-RPC, `GET` = server→client SSE. Served at the root so it can sit behind its own host, e.g. `https://mcp.metro.box`. |
| `GET /health` | liveness + configured accounts (no auth, no secrets) |
| `POST /wh/<id>` | inbound webhook receiver |
| `/api/state`, `/api/tail`, `/api/call/<station>/<action>` | optional external monitor API (token-gated; the in-process MCP does not use it) |

Register the MCP with a client:

```sh
claude mcp add --transport http metro http://127.0.0.1:8420
```

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

All configuration comes from the environment — no config files are required. Copy
[`.env.example`](.env.example) to `.env` and fill in the stations you want. Configure
at least one station.

### XMTP identity

The XMTP station derives its account(s) from a **BIP-39 mnemonic** and always runs
on the production XMTP network.

| Var | Meaning |
| --- | --- |
| `MNEMONIC` | BIP-39 mnemonic the HD accounts derive from (`m/44'/60'/0'/0/<index>`) |
| `DERIVE_COUNT` | How many HD accounts to derive (indices `0..N-1`). Default `1` |

If `MNEMONIC` is unset the XMTP station exits with a clear error. Accounts derive at
indices `0..DERIVE_COUNT-1` with ids `x0..xN`. For richer setups, a
`~/.metro/xmtp-accounts.json` file (path overridable via `XMTP_ACCOUNTS_FILE`) lists
accounts explicitly — each entry sets a `derive` index.

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

### MCP & server env

| Var | Default | Meaning |
| --- | --- | --- |
| `METRO_CHANNEL_ALLOWLIST` | (built-in) | Comma list of allowed sender ids; inbound from senders not on the list is dropped. `*` disables gating (unsafe — prompt-injection surface). |
| `METRO_CHANNEL_STATIONS` | `xmtp,telegram,discord` | Stations to surface to the MCP (`webhook` always excluded) |
| `METRO_WEBHOOK_PORT` | `8420` | The single HTTP server port |
| `METRO_MCP_HTTP_TOKEN` | — (off) | Optional bearer gating the MCP endpoint for external clients |
| `METRO_MONITOR_TOKEN` | — (off) | Optional bearer gating the external `/api/*` monitor endpoints. **Not required** — the MCP runs in-process. |

### Logging

`METRO_LOG_LEVEL` — one of `trace|debug|info|warn|error|fatal` (default `info`).
Logs go to stderr.

## State & volumes

Metro is **stateful** and needs a **persistent local volume**:

- **XMTP MLS encryption databases** — the node SDK stores each account's MLS group
  state in a SQLite DB under `~/.metro/` (`xmtp-<env>-<id>.db3`, path overridable per
  account via `dbPath`). These must persist: losing them re-installs the inbox and
  drops decryption keys for existing groups.
- **Outbox / journal / IPC** under `$METRO_STATE_DIR` (default `~/.cache/metro`) — the
  durable outbox (at-least-once outbound delivery), the append-only history journal
  (which the in-process MCP tails for inbound), the line/bot caches, the IPC unix
  socket, and the singleton lockfile.

Mount a durable volume at `~/.metro` (and `$METRO_STATE_DIR`) when deploying. All
secrets still come from the environment.

## Stations & trains

Stations do **not** start automatically. The daemon's train supervisor spawns the
scripts in `~/.metro/trains/*.{ts,js,mjs}` (hot-reloaded) and multiplexes their event
streams. The built-in stations live in [`src/stations/`](src/stations) and **boot on
import**, so a one-line train file runs one:

```ts
// ~/.metro/trains/xmtp.ts
import '<path-to-repo>/src/stations/xmtp/index.ts';
```

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

## macOS: XMTP native binding

`@xmtp/node-bindings` (bundled by `@xmtp/node-sdk`) ships a darwin binary built under
Nix that hardcodes a dead `/nix/store/…/libiconv.2.dylib` load path, so `dlopen` fails
with a misleading "Cannot find native binding". The train supervisor sets
`DYLD_FALLBACK_LIBRARY_PATH=/usr/lib` in each station subprocess's environment
([`src/trains/supervisor.ts`](src/trains/supervisor.ts)) so dyld resolves the system
libiconv. No binary patching, no postinstall; a no-op off macOS.

## Development

A single Bun package — no workspaces.

```sh
bun install
bun run build      # tsc -> dist/
bun run typecheck  # tsc --noEmit (daemon + in-process MCP)
bun run test       # tsc + bun test
bun run lint       # eslint
```

## Project structure

```
src/
  server.ts       # entry — boots the daemon, which serves the MCP in-process
  dispatcher*.ts  # dispatcher boot + outbound routing + webhook attribution + MCP mount
  mcp/            # the MCP surface (createMetroMcp) — mounted in-process at the root path
  monitor-api.ts  # the optional external /api/* monitor endpoints (+ /health)
  trains/         # station supervisor + the station<->daemon protocol
  stations/       # built-in stations (xmtp, telegram, discord) + account loaders
  broker/         # claims + history streaming (the tail the in-process MCP follows)
  codex-rc/       # codex bridge (protocol, client)
  registry*.ts    # the verb registry (single source of truth) + types
  sessions.ts     # sessions.json binding layer
  lines.ts        # the typed metro:// Line parser
  schema.ts       # the metro-call validator
  define-train.ts # public helper for authoring stations
```

## License

MIT
