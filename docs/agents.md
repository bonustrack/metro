# Metro: a guide for coding agents

You are running inside a session that has **launched `metro`** in the background. Metro emits a live stream of JSON events from Discord, Telegram, and other agents on its stdout. Your job is to consume that stream and post replies back via `metro raw` (the pass-through to the platform's native REST API).

## Starting the bridge

The launch mechanics differ by runtime — pick the one that matches yours.

### Claude Code

```
Bash(command: "metro", run_in_background: true)
```

Then attach `Monitor` to its stdout. Each line is one JSON event you act on.

### Codex

```
shell(command: "METRO_CODEX_RC=ws://127.0.0.1:8421 metro", run_in_background: true)
```

Don't watch its stdout — Codex has no Monitor equivalent. Metro pushes each event into your thread via JSON-RPC `turn/start`, so events arrive as user input on your next turn. The user must have a daemon and TUI running for this to work:

```
codex app-server --listen ws://127.0.0.1:8421       # daemon (terminal 1)
codex --remote ws://127.0.0.1:8421                  # TUI (this session — terminal 2)
```

Run `metro doctor` if anything seems off.

## Event shape

Every event is a **history entry** — the same record that's appended to `history.jsonl`. Fields: `kind` (`inbound`/`outbound`/`notification`), `id` (`msg_…`), `ts`, `station`, `line` (conversation), `lineName?`, `from` (participant URI), `fromName?`, `to`, `text`, `messageId?` (platform-side id; inbound only), `payload?` (raw platform message; inbound only).

```json
{"kind":"inbound","id":"msg_aB3xY7zP","ts":"2026-05-14T12:00:00Z","station":"telegram","line":"metro://telegram/-100…/247","lineName":"infra","from":"metro://telegram/user/12345","fromName":"@alice","to":"metro://claude/agent","messageId":"4567","text":"hello","payload":{"message_id":4567,"chat":{"id":-100,"type":"supergroup","is_forum":true},"from":{"id":12345,"username":"alice"},"text":"hello","entities":[{"type":"mention","offset":0,"length":6}],"photo":[{"file_id":"…"}],"reply_to_message":{"message_id":4500,"text":"earlier","from":{"id":99,"username":"bob"}}}}
```

```json
{"kind":"notification","id":"msg_pQ4r5sT0","ts":"…","station":"claude","line":"metro://claude/deploys","from":"metro://codex/ci","to":"metro://claude/deploys","text":"deploy succeeded"}
```

### `payload` by station

`payload` is the platform's native message shape. Narrow on `event.station`:

- **`discord`** — discord.js `Message.toJSON()`: camelCase fields (`channelId`, `guildId`, `content`, `author`, `mentions: { users[], roles[], everyone }`, `attachments[]`, `reference`, …). Most collections come back as **arrays of IDs**; `attachments[]` is grafted to full objects (`{ id, name, url, contentType, size, ... }`). `referencedMessage` (also `toJSON()`-shaped) is added inline on replies (auto-fetched).
- **`telegram`** — raw Bot API `Message` (snake_case): `{ message_id, chat, from, text, caption, entities[], photo[], document, voice, audio, reply_to_message, … }`. `reply_to_message` is inline on replies.

Use `payload` for anything the envelope doesn't surface — mentions, reply chains, embeds, stickers, entities.

Both `from` and `to` are **participant URIs** (the conversation lives in `line`): `metro://<station>/user/<id>` for a person, `metro://claude/<topic>` / `metro://codex/<topic>` for an agent.

When **you** call `metro raw` or `metro notify`, the outbound history entry's `from` is auto-stamped to your runtime — `metro://claude/agent` (from `$CLAUDECODE`) or `metro://codex/agent` (from `$METRO_CODEX_RC`/`$CODEX_HOME`). Override with `--from=<uri>` or `$METRO_FROM`.

- `kind: "inbound"` — a human (or another bot) posted on a chat platform.
- `kind: "notification"` — another agent called `metro notify` against your agent line. This is how Codex pings Claude Code and vice versa.

`text` is the literal text content (Telegram `text`/`caption`, Discord `content`). It may be empty for attachment-only messages — inspect `payload` to detect images, voice, audio, documents, etc. Images can be materialized via `metro download`.

## Required flow on every event

1. **Echo the event** to your visible output: `[<line>#<messageId>] <text>`. Both Monitor and Codex collapse tool output, so this echo is the only thing the user sees without expanding cards.
2. **Decide and act** using `metro raw` (or one of the helpers below).

## Detecting "is this for me?"

Derive from `payload`. Bot id per station is in `$METRO_STATE_DIR/bot-ids.json` (`{discord:"<userId>", telegram:"<userId>"}`).

- **`discord`** — DM if `payload.guildId == null`; otherwise pinged if `payload.mentions.users.includes(<bot-id>)`.
- **`telegram`** — DM if `payload.chat.type === 'private'`; otherwise pinged if any entity in `payload.entities` (or `caption_entities`) is `{type:"mention"}` matching `@<bot-username>`, or `{type:"text_mention", user:{id:<bot-id>}}`.

Default: only reply on DM or ping; otherwise stay silent.

## Sending messages — `metro raw`

There is no `metro send` / `reply` / `edit` / `react`. To do anything outbound on a chat station, call its native REST API through `metro raw`:

```
metro raw <station> <method> <path> [--body=<json>]
```

The daemon attaches the bot token automatically. `--body` can come from stdin if omitted (heredoc).

### Telegram

Base URL: `https://api.telegram.org/bot<TOKEN>`. See the [Bot API docs](https://core.telegram.org/bots/api).

```bash
# Send
metro raw telegram POST /sendMessage --body='{"chat_id":25220238,"text":"hello"}'

# Reply (threaded)
metro raw telegram POST /sendMessage --body='{"chat_id":25220238,"text":"ack","reply_parameters":{"message_id":641}}'

# Edit
metro raw telegram POST /editMessageText --body='{"chat_id":25220238,"message_id":642,"text":"updated"}'

# React
metro raw telegram POST /setMessageReaction --body='{"chat_id":25220238,"message_id":641,"reaction":[{"type":"emoji","emoji":"👍"}]}'

# Forum topic: include "message_thread_id" in the body
```

Pull `chat_id` from `payload.chat.id` on the inbound, topic id from `payload.message_thread_id`, reply target from `payload.message_id`.

### Discord

Base URL: `https://discord.com/api/v10`. See the [Discord REST docs](https://discord.com/developers/docs/reference).

```bash
# Send
metro raw discord POST /channels/<channelId>/messages --body='{"content":"hello"}'

# Reply (threaded)
metro raw discord POST /channels/<channelId>/messages --body='{"content":"ack","message_reference":{"message_id":"<id>"}}'

# Edit
metro raw discord PATCH /channels/<channelId>/messages/<messageId> --body='{"content":"updated"}'

# React
metro raw discord PUT /channels/<channelId>/messages/<messageId>/reactions/%F0%9F%91%8D/@me
```

`flags: 4` (1 << 2) on a Discord send suppresses link previews. Pull `channelId` from `payload.channelId`, reply target from `payload.id`.

### Heredoc for long bodies

```bash
metro raw discord POST /channels/123/messages --body="$(cat <<'EOF'
{"content":"line one\nline two\nline three"}
EOF
)"
```

`metro raw` does **not** support multipart file uploads yet. For images and other files, host them and pass the URL; both platforms accept URLs in the relevant fields.

## Other subcommands

| Command | Purpose |
|---|---|
| `metro notify <agent-line> <text>` | Ping another agent (`metro://claude/<topic>` or `metro://codex/<topic>`). |
| `metro download <line> <messageId> [--out=<dir>]` | Materialize image attachments to disk. |
| `metro fetch <line> [--limit=N]` | Recent-channel history (Discord only). |
| `metro history` | Universal message log. Filters: `--limit`, `--line`, `--station`, `--kind`, `--from`, `--text`, `--since`, `--json`. |
| `metro lines` | List recently-seen conversations. |
| `metro stations` | List stations + capabilities. |
| `metro doctor` | Health check. |

All commands accept `--json` for parseable output.

## `metro history` — read the universal message log

Every inbound, outbound, and notification is appended to `$METRO_STATE_DIR/history.jsonl` automatically.

```bash
metro history --limit=20                              # recent 20, newest first
metro history --line=metro://discord/123              # only this conversation
metro history --kind=inbound --since=2026-05-14       # inbounds since that day
metro history --station=telegram --text=deploy        # all Telegram entries containing "deploy"
metro history --from='@alice' --json                  # everything from alice, JSON
```

Filters: `--limit` (default 50), `--line`, `--station`, `--kind` (`inbound`/`outbound`/`notification`), `--from`, `--text`, `--since` (ISO), `--json`.

## Discovery

### `metro lines`

```
$ metro lines
2m ago    metro://discord/1234567890           infra
5m ago    metro://telegram/-100123/42          design-review
```

Lines sorted by recency. Use when the user says "the Telegram channel" or "that PR thread."

### `metro stations`

```
$ metro stations
  ✓ discord    chat   in: text+image · out: text · features: download, fetch, raw
  ✓ telegram   chat   in: text+image · out: text · features: download, fetch, raw
  · claude     agent  in: text · out: – · features: notify
  ✓ codex      agent  in: text · out: – · features: notify
```

`✓` = ready, `✗` = configured-but-broken, `·` = informational.

## Image attachments

When an inbound has `payload.photo` (Telegram) or a `payload.attachments[]` entry with `contentType` starting with `image/` (Discord):

1. `metro download <line> <messageId>` → prints absolute paths.
2. `Read` each path with your `Read` tool — the image enters your context as a vision input.
3. Reply via `metro raw`.

## Cross-agent notification

Both agents can post to each other's "agent line" — a logical channel under `metro://claude/<topic>` or `metro://codex/<topic>`. The daemon re-emits the post on its stdout stream (and pushes via codex-rc if configured), so the peer agent sees it as a notification:

```bash
metro notify metro://claude/deploys "build green, ready to ship"
metro notify metro://codex/ci "build green" --from=metro://claude/deploys   # override sender
```

This requires the metro daemon to be running on the machine. Without a daemon, agent-line sends error with a clear message.

## Don'ts

- ❌ Spawning a second metro daemon — there's one per machine (lockfile-enforced).
- ❌ Bypassing `metro raw` to call Discord/Telegram REST directly with your own HTTP client. The daemon owns auth, history logging, and rate-limit handling.
- ❌ Narrating the tool ("I'll now use metro raw to…"). The tool call is already visible.

## Further reading

- URI scheme: [`uri-scheme.md`](uri-scheme.md)
- Source: https://github.com/bonustrack/metro
