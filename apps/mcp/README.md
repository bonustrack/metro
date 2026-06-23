# @metro-labs/mcp

> The Metro core daemon: the MCP protocol surface, the supervised runtime, and the
> station contract the platform packages implement.

This is the entry-point package of the monorepo (see the [root README](../../README.md)
for what Metro is and how to run/deploy it). It ships the `metro-daemon` bin
(`./dist/server.js`) and the `@metro-labs/mcp/*` exports the station packages depend on.
`src/server.ts` just imports `daemon/boot`, which boots one in-process daemon that
serves the MCP and supervises a subprocess ("train") per configured station.

## Three areas

### `src/mcp/` — the MCP protocol surface

The Model Context Protocol server (`createMetroMcp`), mounted at the root path of the
HTTP server so it can sit behind its own host. It exposes the `mcp__metro__*` tools
(`send`/`reply`/`react`/`read`/`create_channel`/… plus `list_accounts`), gathers the
configured accounts (`accounts.ts`), routes each tool call to the owning station by its
`line` (`call-tools.ts`), and runs the **inbound relay** (`inbound.ts`): it subscribes
to the daemon event bus and pushes `notifications/claude/channel` to the connected AI
client. `ctx.ts` builds the per-call `ToolContext` and the outbound `metroCall` bridge;
`tool-schemas.ts` holds the tool/zod schemas; `keepalive.ts` keeps the session warm.
The HTTP transport is session-tolerant — it survives a daemon restart so connected
sessions auto-resume.

### `src/daemon/` — the supervised runtime

- `boot.ts` — wires everything together at startup (lock, identity, supervisor, HTTP,
  IPC, MCP mount).
- `supervisor.ts` / `supervisor-io.ts` — the **train supervisor**: spawns one
  subprocess per train script in `METRO_TRAINS_DIR` (`~/.metro/trains/*` by default),
  hot-reloads them, and multiplexes their JSON event stream.
- `http.ts` — the dispatcher HTTP server on `METRO_WEBHOOK_PORT` (8420): the public
  `GET /health`, the MCP at `/` and `/mcp`, and the webhook receiver at `/wh/<id>`.
  `makeEmit` publishes train events onto the event bus.
- `events.ts` — the in-memory event bus (`subscribeEvents`, `mintId`, the `MetroEvent`
  shape) the MCP relay subscribes to. Inbound is never journaled to disk.
- `ipc.ts` — the Unix-socket IPC server used to forward outbound calls to trains.
- `protocol.ts` — the station↔daemon wire protocol / envelope (`@metro-labs/mcp/trains/protocol`).
- `paths.ts`, `tunnel.ts`, `identity.ts`, `log.ts`, `secure-fs.ts`, `train-error.ts` —
  state dirs + singleton lock, webhook port/tunnel config, user identity, pino logger,
  scoped fs, train error formatting.

### `src/stations/` — the station contract the core reads

- `types.ts` — the `Station` / `StationTool` / `Verb` / `ToolContext` contract.
- `station-runtime.ts` — `makeStation`, `CallMsg`, the emit/respond/mintId helpers a
  train uses.
- `account-store.ts` — the multi-bot account store (csv parsing, id generation).
- `attachments.ts` — `saveBufferToCache`, `toCanonical`, the MIME table.
- `messaging-normalize.ts` — shared inbound normalization helpers.
- `lines.ts` — the `metro://<station>/<path>` Line parser.
- `registry.ts` — the static list of station descriptors (`STATIONS`) the core reads:
  it imports each package's `.` export (`xmtpStation`, `telegramStation`,
  `discordStation`, `webhookStation`) and resolves a line/verb to its owner.

## Architecture (in-process)

```
train subprocess --(JSON event)--> dispatcher http.makeEmit
  --> daemon event bus (events.ts) --> MCP inbound relay --> AI client (channel notification)

AI client --(mcp__metro__* tool call)--> mcp/call-tools --> IPC forward-call --> train subprocess
```

Everything runs in one Bun process. A station is consumed two ways: as a **descriptor**
(its `.` export / `station.ts`, read by the registry) and as a **train subprocess**
(its `./train` export / `index.ts`, spawned by the supervisor). See the root README's
"How it works" and each station package's README.

## Exports

`@metro-labs/mcp` re-exports the core building blocks the station packages import:
`.` (createMetroMcp), `./server`, `./log`, `./train-error`, `./secure-fs`, `./lines`,
`./events`, `./endpoints`, `./trains/protocol`, and `./stations/*` (`types`,
`station-runtime`, `account-store`, `attachments`, `messaging-normalize`).

## Scripts

```sh
bun run start        # bun src/server.ts (the metro-daemon)
bun run build        # tsc -> dist/
bun run typecheck    # tsc --noEmit
bun run test         # tsc + bun test test/
bun run lint
```
