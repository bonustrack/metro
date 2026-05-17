---
name: metro
description: Run the metro worker-supervisor in this session — launch `metro` in the background, watch its stdout for inbound JSON events, and act on each. Use when the user asks to start/run/launch metro, when you see JSON lines on stdout shaped `{"kind":"inbound","station":...,"line":"metro://...","messageId":...,"text":...}`, or when handling a chat/webhook reply/edit/react/send via `metro call`.
---

# Metro — event-interception wire

Metro is not a platform connector. Metro is the **wire** between this session and any number
of platforms. The actual platform code lives in **workers** under `~/.metro/workers/` — single
TS files that you (the agent) write, edit, or replace on demand.

## What metro does

1. Spawns each file in `~/.metro/workers/*.{ts,js,mjs}` as a long-running Bun subprocess.
2. Multiplexes their stdout (JSON lines) into one unified event stream on metro's stdout.
3. Routes outbound `metro call <worker> <action> <args>` requests back to the matching worker's stdin and prints the response.
4. Two builtin event sources stay in core (no worker file needed): **webhooks** (HTTP receiver) and cross-user **notify** IPC.

That's it. Platform-specific code, credentials, and dependencies all live in `~/.metro/` — outside metro's repo.

## Starting metro

### Claude Code

```
Bash(command: "metro", run_in_background: true)
```

Then attach `Monitor` to its stdout. Each line is one JSON event. Stderr is logs.

### Codex

```
shell(command: "METRO_CODEX_RC=ws://127.0.0.1:8421 metro", run_in_background: true)
```

Metro pushes each event into your thread via JSON-RPC `turn/start`, so events arrive as user input on your next turn. The user must have a daemon + TUI running on the **same WebSocket URL**:

```
codex app-server --listen ws://127.0.0.1:8421     # daemon
codex --remote ws://127.0.0.1:8421                # TUI — type "hi" once to seed a thread
```

### Diagnostics

`metro doctor` reports: workers found, deps installed (`~/.metro/package.json`), dispatcher running, codex-rc, skill install.

## Worker protocol

### Inbound event line (worker → metro stdout)

```json
{"kind":"inbound","station":"discord","line":"metro://discord/123","from":"metro://discord/user/456","fromName":"alice","messageId":"789","text":"hi","isPrivate":false,"ts":"2026-05-17T18:00:00Z","payload":{...}}
```

Workers produce the full envelope — `line`, `from`, `fromName`, `text`, `isPrivate`. Metro mints `id` + `display` if they're missing and appends the entry to `history.jsonl`. Then on metro's stdout you see the same envelope back, now enriched with `display`.

Event kinds: `inbound`, `outbound`, `edit`, `react`. `payload` is the platform's native message shape — use it for mentions, replies, embeds, etc.

### Outbound action call (`metro call <worker> <action> <args>`)

```
metro call discord send '{"line":"metro://discord/123","text":"hi","replyTo":"789"}'
metro call telegram react '{"line":"metro://telegram/-100/1","messageId":"42","emoji":"👀"}'
metro call discord edit  '{"line":"metro://discord/123","messageId":"999","text":"new"}'
```

`[args]` can be JSON, `@path/to/args.json`, `-` (stdin), or a bare string. Metro forwards the call to the named worker via its stdin, awaits the response, and prints `result` JSON (or fails with the worker's error).

Action names are **whatever the worker exposes**. Metro core knows nothing about them. The current example workers (`discord.ts`, `telegram.ts`) expose `send`, `edit`, `react`.

## Writing a new worker

When the user asks for a new platform or behavior:

1. Read `node_modules/@stage-labs/metro/examples/` (or the published `examples/` folder) for a starting template.
2. Copy → `~/.metro/workers/<name>.ts`.
3. Edit: keep the inbound-event shape and the `op:"call"` → `op:"response"` protocol; everything else is your call.
4. If it needs deps, `cd ~/.metro && bun add <pkg>`.
5. Credentials: `echo 'FOO_TOKEN=…' >> ~/.metro/.env`.
6. Restart the metro daemon to pick up the new worker (no hot-reload in v1).

Workers are throwaway. If the user asks for new functionality, **rewrite the worker** rather than adding glue in core.

## First-run setup (one time per machine)

```
mkdir -p ~/.metro && cd ~/.metro && bun init -y
# Add deps your workers need:
bun add discord.js
# Drop in starter workers (copy from this package's examples/):
cp node_modules/@stage-labs/metro/examples/discord.ts ~/.metro/workers/
# Set credentials (workers read process.env, metro auto-loads this):
echo 'DISCORD_BOT_TOKEN=…' >> ~/.metro/.env
# Optional: install the skill
metro setup skill
# Start it
metro
```

## Detecting "is this for me?"

Workers should set `isPrivate: true` for DMs. For groups, narrow on `payload`:

- **discord** — DM when `payload.guildId == null`; otherwise look at `payload.mentions.users`.
- **telegram** — DM when `payload.chat.type === 'private'`; otherwise look at `payload.entities` mentions.
- **webhook** — every POST is for you by design (you registered the endpoint). Route on `payload.headers['x-github-event']` / `x-intercom-topic` etc.

## CLI cheat sheet

```
metro                                    # start the daemon
metro workers list                       # list workers + state
metro call <worker> <action> <args>      # forward an action call
metro tail --as=<user-uri> [--follow]    # subscribe to the event log
metro history --limit=50                 # recent history (newest first)
metro webhook add <label>                # add an HTTP receive endpoint
metro tunnel setup <name> <hostname>     # configure a Cloudflare named tunnel
metro doctor                             # health check
```

## Webhooks (builtin source)

Webhooks stay in core because they're shared HTTP infra (one Cloudflare tunnel can route to many endpoints). They emit `kind:"inbound", station:"webhook"` events directly. `metro webhook add <label>` issues an endpoint id; the full URL is `https://<tunnel-host>/wh/<id>` (or `http://127.0.0.1:8420/wh/<id>` locally).

## What metro does NOT do

- It does not understand any specific platform. Connectors are worker scripts you write.
- It does not auto-load worker dependencies. Use `~/.metro/package.json` (run `bun init`).
- It does not hot-reload workers. Restart the daemon to pick up edits.
- It does not ship per-platform CLI verbs. The only outbound is `metro call`.

If a worker crashes, metro restarts it with backoff (1s → 5s → 30s, then gives up after 5 consecutive failures). Use `metro workers list` to check state.
