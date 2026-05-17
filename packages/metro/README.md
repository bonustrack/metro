# Metro

[![npm](https://img.shields.io/npm/v/@stage-labs/metro/beta?label=npm&color=cb3837)](https://www.npmjs.com/package/@stage-labs/metro)

> **Event-interception wire. Supervises worker subprocesses, multiplexes their stdout into one
> JSON event stream, routes outbound action calls back via stdin. Per-platform code lives in
> worker scripts under `~/.metro/workers/` — outside this repo — written by the user (or agent)
> on demand.**

Metro is not a framework with platform connectors. Metro is the wire.

```
[Claude Code session]

$ metro &                              # backgrounded
$ Monitor( … metro's stdout … )

>>> {"kind":"inbound","station":"discord","line":"metro://discord/123…","messageId":"9876",
     "text":"@metro 5xx spike on /v1/sync — look?",
     "payload":{"channelId":"123…","guildId":"456…","content":"<@…> 5xx spike…",
                "mentions":{"users":["<bot-id>"],"roles":[],"everyone":false},…}}

  [I'd grep services/sync.ts, then…]
  Bash: metro call discord send '{"line":"metro://discord/123…","text":"three deploys in the last 24h…","replyTo":"9876"}'
```

You own streaming, tool calls, and reply timing. Metro is the wire.

---

## Quickstart

```bash
npm install -g @stage-labs/metro@beta    # or: bun add -g @stage-labs/metro@beta

# One-time worker setup
mkdir -p ~/.metro && cd ~/.metro && bun init -y
bun add discord.js                          # for the discord example worker
cp $(npm root -g)/@stage-labs/metro/examples/discord.ts ~/.metro/workers/
echo 'DISCORD_BOT_TOKEN=your-token' >> ~/.metro/.env

metro doctor                                # verify
metro                                       # run the daemon
```

Requires **Bun ≥ 1.3** (workers run under `bun run`). Metro core itself works under Node ≥ 22.

---

## Architecture

```
~/.metro/workers/discord.ts ──> stdout JSON ──┐
~/.metro/workers/telegram.ts ─> stdout JSON ──┤
~/.metro/workers/<anything>.ts ─> stdout ─────┼──>  metro daemon ──>  stdout (Monitor / Codex push)
                                              │                       history.jsonl
HTTP /wh/<id>  (builtin webhook receiver) ────┤
IPC `notify`   (builtin cross-user channel) ──┘

metro call discord send {…}  ──>  IPC ──>  daemon  ──>  worker stdin  ──>  response  ──> CLI stdout
```

Every event metro emits is a `HistoryEntry`. Workers produce the full envelope; metro just
enriches `id`/`display` and appends to `history.jsonl`. Outbound action calls are
worker-defined — metro core knows the protocol (`{op:"call", id, action, args}` → `{op:"response", id, result|error}`),
not what any specific action does.

---

## Worker protocol

**Inbound (worker → metro stdout)** — one JSON line per event:

```json
{"kind":"inbound","station":"discord","line":"metro://discord/123","from":"metro://discord/user/456","fromName":"alice","messageId":"789","text":"hi","isPrivate":false,"ts":"2026-05-17T18:00:00Z","payload":{...}}
```

**Outbound (metro → worker stdin)** — one JSON line per action call:

```json
{"op":"call","id":"req_abc","action":"send","args":{"line":"metro://discord/123","text":"hi"}}
```

Worker responds on stdout:

```json
{"op":"response","id":"req_abc","result":{"messageId":"999"}}
```

See [`examples/`](./examples/) for two reference workers (Discord + Telegram) and the full protocol doc.

---

## CLI

```
metro                                    # start the daemon (foreground)
metro workers [list]                     # supervised workers + state
metro call <worker> <action> <args>      # forward an action call; args = JSON / @file / - / string
metro tail --as=<user-uri> [--follow]    # subscribe to the event log; claim-aware
metro history --limit=50                 # recent history (newest first)
metro lines                              # recently-seen conversations
metro claim <line>                       # take exclusive ownership of a line
metro release <line>                     # release
metro claims                             # print the claims map
metro webhook add <label> [--secret=…]   # add an HTTP receive endpoint
metro webhook list | remove <id>         # manage endpoints
metro tunnel setup <name> <hostname>     # configure a Cloudflare named tunnel
metro setup [skill [clear]]              # install/remove the metro skill into ~/.claude / ~/.codex
metro doctor                             # health check
metro update                             # upgrade in place
```

---

## Why workers?

Earlier metro shipped first-class `discord` / `telegram` / `webhook` stations + typed verbs
(`metro send`, `metro reply`, `metro edit`, `metro react`, `metro download`, `metro fetch`).
That coupled the metro release cycle to every platform's API changes. The agent can write a
Discord worker in 80 LOC — there's no reason for metro core to own it.

Workers live in `~/.metro/workers/`. If you want a new platform or behavior, write a new worker
(or ask the agent to). Metro doesn't change.

---

## State

- `~/.metro/workers/` — your worker scripts
- `~/.metro/.env` — your credentials (workers read these)
- `~/.metro/package.json` — `bun add` here for worker deps
- `$METRO_STATE_DIR` (default `~/.cache/metro/`) — history, claims, cursors, monitor data

---

## License

MIT
