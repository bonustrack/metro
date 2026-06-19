# @metro-labs/metro

> Event-interception wire for live chat streams into AI coding sessions, exposed as a **stateless MCP server**.

This is a **single package at the repository root** — not a monorepo. The primary
entry is the **MCP server**; a daemon entry supervises the platform "trains".

- **MCP server** (`metro-channel`, [`src/mcp/index.ts`](src/mcp/index.ts)) — the
  primary entry. Bridges Metro chat into AI sessions over **stdio** (local) or
  **Streamable HTTP** (cloud). It is **stateless**: all config + secrets come from
  the environment and it reads/writes no state files on disk (the only filesystem
  reads are inbound attachment paths handed to it in a tool call). Exposes
  `GET /health` (no auth) and the channel/messaging tools. See
  [`src/mcp/README.md`](src/mcp/README.md).
- **Daemon** (`metro-daemon`, [`src/server.ts`](src/server.ts)) — supervises train
  subprocesses in `~/.metro/trains/` (or `$METRO_TRAINS_DIR`), multiplexes the JSON
  events they emit onto one stdout stream, runs the durable outbox, and serves the
  webhook + monitor HTTP/SSE API. The daemon keeps local state — see [State](#state).

The wire knows nothing about Telegram, Discord, or XMTP: platform behaviour is
written as train scripts on top of the transport this package provides. Each train
is a `<name>.ts` file under `~/.metro/trains/`; the supervisor spawns it, restarts
it with backoff on crash, and pipes a newline-delimited JSON protocol over
stdin/stdout. The agent-facing playbook is [`skills/metro/SKILL.md`](skills/metro/SKILL.md);
the URI scheme is [`docs/uri-scheme.md`](docs/uri-scheme.md); broker and monitor
internals are in [`docs/broker.md`](docs/broker.md) and [`docs/monitor.md`](docs/monitor.md).

Metro requires the [Bun](https://bun.sh) runtime (trains are spawned with `Bun.spawn`).

## Development

A single Bun package — no workspaces, no Turbo.

```sh
bun install
bun run build      # tsc -> dist/
bun run typecheck  # daemon (tsconfig.json) + MCP entry (tsconfig.mcp.json)
bun run test       # tsc + bun test
bun run lint       # eslint
```

## Run the MCP server (ENV only, no Docker)

The MCP server takes **all** config from the environment — no config files, no
`/data` volume, no Docker. Run it directly with Bun.

```sh
# stdio (local: a single Claude Code / Codex client over the process pipes)
METRO_MONITOR_TOKEN=... METRO_BASE_URL=http://127.0.0.1:8420 \
  bun src/mcp/index.ts

# Streamable HTTP (cloud: hostable, multi-client, behind a load balancer)
METRO_MCP_TRANSPORT=http METRO_MCP_HTTP_PORT=8421 \
METRO_MONITOR_TOKEN=... METRO_BASE_URL=http://127.0.0.1:8420 \
  bun src/mcp/index.ts
# liveness : GET  http://<host>:8421/health   (no auth, no secrets)
# MCP      : POST http://<host>:8421/mcp       (optional METRO_MCP_HTTP_TOKEN bearer)
```

### MCP server env

| Var | Default | Meaning |
| --- | --- | --- |
| `METRO_MONITOR_TOKEN` | — (REQUIRED) | Bearer for the daemon HTTP API the bridge calls |
| `METRO_BASE_URL` | `http://127.0.0.1:8420` | Daemon webhook/monitor HTTP base |
| `METRO_CHANNEL_ALLOWLIST` | tony-account inbox id | Comma-separated allowed sender ids; `*` disables gating (unsafe) |
| `METRO_CHANNEL_STATIONS` | `xmtp,telegram,discord` | Stations to surface (`webhook` always excluded) |
| `METRO_MCP_TRANSPORT` | `stdio` (`http` if `METRO_MCP_HTTP_PORT` set) | `stdio` or `http` |
| `METRO_MCP_HTTP_PORT` | `8421` | Streamable-HTTP port |
| `METRO_MCP_HTTP_HOST` | `0.0.0.0` | Streamable-HTTP bind host |
| `METRO_MCP_HTTP_TOKEN` | — (off) | Optional bearer gating `POST /mcp` |

## Run the daemon

```sh
bun src/server.ts        # boots the dispatcher (no CLI, no argv parsing)
```

Station secrets (XMTP mnemonic, Discord / Telegram bot tokens) come from **env**
(comma-separated multi-bot lists, mnemonic-derived XMTP accounts). See
[`.env.example`](.env.example).

## State

The **MCP server is stateless**. The **daemon** is not: it keeps local state under
`$METRO_STATE_DIR` (default `~/.cache/metro`) — the append-only history journal,
the durable outbox, the line/bot caches, the IPC unix socket, the singleton
lockfile — plus per-station XMTP MLS databases under `~/.metro/`. That state is
inherent to the supervisor/transport role and is out of scope for the
stateless-*server* requirement; it is flagged here rather than removed because the
daemon entry depends on it. All daemon secrets still come from env only.

## The Line scheme

Every conversational scope is a **Line** — an opaque URI `metro://<station>/<path>`.
The station (`discord`, `telegram`, `xmtp`, `claude`, `codex`, `webhook`,
`session`, …) is the host; the path is station-specific. A single typed `Line`
parser ([`src/lines.ts`](src/lines.ts)) owns the whole scheme. See
[`docs/uri-scheme.md`](docs/uri-scheme.md) for the full grammar.

## The event envelope

Inbound and outbound events share one shape (`Envelope` in
[`src/define-train.ts`](src/define-train.ts)): `{kind?, id?, ts?, station?, line,
line_name?, from?, from_name?, to?, message_id?, reply_to?, is_private?, text?,
emoji?, payload?, account?}`. Trains emit via `ctx.emit` / `ctx.emitInbound` /
`ctx.emitOutbound`; the daemon stamps `id`/`ts`/`station` when missing and routes
the result to stdout and history.

## Writing a train

```ts
import { defineTrain } from '@metro-labs/metro/define-train';

export default defineTrain({
  station: 'example',
  async onInbound({ emit }) {
    emit({ line: 'metro://example/demo', from: 'someone', text: 'hi' });
  },
  actions: {
    async send({ line, text }) {
      // deliver `text` to `line` on your platform
    },
  },
});
```

Place `<name>.ts` files in `~/.metro/trains/`. The supervisor spawns the train,
restarts it with backoff on crash, and pipes the newline-delimited JSON protocol.

## Project structure

```
src/
  mcp/            # the MCP server (primary entry: src/mcp/index.ts) — stateless
  server.ts       # daemon entry (re-exports dispatcher.ts)
  dispatcher*.ts  # dispatcher boot + outbound routing + webhook attribution
  trains/         # train supervisor + the train<->daemon protocol
  stations/       # built-in station normalizers (discord, telegram, xmtp)
  broker/         # claims + history streaming between daemon and clients
  codex-rc/       # codex bridge (protocol, client)
  registry*.ts    # the verb registry (single source of truth) + types
  sessions.ts     # sessions.json binding layer
  lines.ts        # the typed metro:// Line parser
  schema.ts       # the metro-call validator
  define-train.ts # public helper for authoring trains
docs/             # uri-scheme, broker, monitor
skills/metro/     # the agent-facing SKILL.md
```

## License

MIT
