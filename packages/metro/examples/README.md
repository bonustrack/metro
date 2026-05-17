# Example workers

Workers in this directory are **examples**, not runtime code. Metro core doesn't import them.

To use one: copy it to `~/.metro/workers/` and edit it. The agent (or you) is expected to rewrite
these files whenever you want different functionality — they're starting points, not a stable API.

## Worker protocol

A worker is a single Bun-runnable script (`*.ts | *.js | *.mjs`) placed in `~/.metro/workers/`.
Metro spawns it as a long-running subprocess with stdio piped:

```
metro core  ──── stdin (one JSON line per outbound action call) ───>  worker
            <─── stdout (one JSON line per inbound event OR response) ──── worker
```

### Inbound event line (worker → metro)

```json
{
  "kind": "inbound",
  "station": "discord",
  "line": "metro://discord/123",
  "from": "metro://discord/user/456",
  "fromName": "alice",
  "messageId": "789",
  "text": "hi",
  "isPrivate": false,
  "ts": "2026-05-17T18:00:00Z",
  "payload": { /* raw platform message */ }
}
```

Metro mints an `id` and a pre-rendered `display` if the worker doesn't supply them. The full
shape mirrors the `HistoryEntry` type in `src/history.ts`.

### Outbound action call (metro → worker)

```json
{ "op": "call", "id": "req_abc", "action": "send", "args": { "line": "metro://discord/123", "text": "hi" } }
```

Worker responds on stdout:

```json
{ "op": "response", "id": "req_abc", "result": { "messageId": "999" } }
```

Or on error:

```json
{ "op": "response", "id": "req_abc", "error": "channel not found" }
```

Anything without an `op` (or `op:"event"`) is treated as an inbound event.

### CLI: `metro call <worker> <action> [args]`

The CLI forwards a call to the named worker via the daemon's IPC socket and prints the response.

```
metro call discord send '{"line":"metro://discord/123","text":"hi"}'
metro call telegram react '{"line":"metro://telegram/-100/1","messageId":"42","emoji":"👀"}'
```

`[args]` accepts JSON, `@path/to/args.json`, `-` (read from stdin), or a bare string.

## First-time setup

```
cd ~/.metro
bun init -y
bun add discord.js              # only if you're using the discord worker
cp <your-package>/examples/discord.ts  ~/.metro/workers/
echo 'DISCORD_BOT_TOKEN=…' >> ~/.metro/.env
```

Then start metro. Workers come up automatically.

## Worker lifecycle

- Metro scans `~/.metro/workers/*.{ts,js,mjs}` at boot. One subprocess per file.
- Workers that crash are restarted with backoff (1s → 5s → 30s, up to 5 consecutive failures).
- `metro workers list` shows current state. `metro` daemon restart picks up new workers.
- `~/.metro/.env` is auto-loaded into worker `process.env`.
