# @metro-labs/metro

> Bridge live chat — XMTP, Telegram, Discord, inbound webhooks — into an AI coding session as MCP tools.

metro lets an AI coding agent (Claude Code) hold real conversations on chat
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
import '/path/to/metro/src/stations/xmtp/index.ts';
```

(The container image generates these automatically — see [Deploying](#deploying).)

## Deploying

[`Dockerfile`](Dockerfile) + [`fly.toml`](fly.toml) run metro on [Fly.io](https://fly.io)
as one always-on machine with a persistent volume. The entrypoint generates a train per
configured station and keeps state on the volume. The full walkthrough — volume,
secrets, custom domain — is in [`DEPLOY.md`](DEPLOY.md):

```sh
fly volumes create metro_data --size 10 --region <region>
fly secrets set MNEMONIC="…" TELEGRAM_BOT_TOKENS="…" METRO_MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

XMTP keeps each inbox's MLS state in a local SQLite database that **must persist**
(losing it re-installs the inbox), and only one instance may run per inbox. metro is
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
| `METRO_MCP_HTTP_TOKEN` | — | Optional bearer gating the MCP endpoint |
| `METRO_LOG_LEVEL` | `info` | `trace`–`fatal`; logs go to stderr |

## Connecting a client

The HTTP server serves the **MCP at the root path** (so it can sit behind its own host,
e.g. `https://mcp.metro.box`), plus `GET /health` and the webhook receiver at
`/wh/<id>`. Register it:

```sh
claude mcp add --transport http metro https://mcp.metro.box \
  --header "Authorization: Bearer <METRO_MCP_HTTP_TOKEN>"
```

metro is a Claude Code **channel** — it pushes inbound chat into a running session.
Start Claude Code with the channel flag:

```sh
claude --dangerously-load-development-channels server:metro
```

Inbound messages then arrive as `<channel source="metro" line="…" …>text</channel>`
events; the agent replies with the tools above, and tool-approval prompts relay to the
chat so you can answer from your phone. (Requires Claude Code v2.1.80+ and claude.ai or
Console API auth.)

## How it works

One process does everything:

- a **supervisor** spawns and multiplexes the station subprocesses,
- the **MCP** is served in the same process — the dispatcher publishes inbound
  events to an in-process event bus, the MCP's inbound relay subscribes and pushes
  `notifications/claude/channel`, and outbound dispatches straight to the stations.

Inbound is never journaled to disk: the dispatcher publishes each event to an
in-memory event bus ([`src/event-bus.ts`](src/event-bus.ts)) and the MCP relay
subscribes to push channel notifications. The MCP HTTP transport is also
session-tolerant: it survives a daemon restart so connected sessions auto-resume.

**Lines.** Every conversation is a `metro://<station>/<path>` URI — the station is the
host, the path is platform-specific (account-scoped for multi-bot). One parser
([`src/lines.ts`](src/lines.ts)) owns the scheme.

**Envelope.** Inbound and outbound events share one shape (`{kind?, id?, ts?, station?,
line, from?, to?, message_id?, text?, payload?, …}`, see
[`src/trains/protocol.ts`](src/trains/protocol.ts)).

**State.** metro is stateful and needs a persistent volume: the XMTP MLS databases under
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

```
src/
  server.ts       # entry — boots the daemon, which serves the MCP in-process
  dispatcher/     # supervisor boot + outbound routing + webhook receiver + MCP mount
  mcp/            # the MCP surface (createMetroMcp), mounted at the root path
  trains/         # station supervisor + the station<->daemon protocol
  stations/       # built-in stations (xmtp, telegram, discord)
  event-bus.ts    # in-memory event bus the MCP relay subscribes to
  lines.ts        # the metro:// Line parser
```

## License

MIT
