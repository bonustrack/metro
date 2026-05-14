---
name: metro
description: Run the metro Telegram/Discord bridge in this session — launch `metro` in the background, watch its stdout for inbound JSON events, and act on each. Use when the user asks to start/run/launch metro, when you see JSON lines on stdout shaped `{"kind":"inbound","station":...,"line":"metro://...","messageId":...,"text":...}`, or when handling chat messages, attachments, or cross-agent notifications.
---

# Metro — running the Telegram & Discord bridge

Metro is a CLI that unifies inbound events from chat platforms (Telegram, Discord) into a single JSON stream for your agent session. Outbound is handled by `metro raw`: a thin pass-through to the platform's native REST API using the daemon's stored bot tokens. You build the platform-shaped request body; metro authenticates and dispatches it.

## Starting the bridge

When the user asks to run/start/launch metro:

### Claude Code

```
Bash(command: "metro", run_in_background: true)
```

Then attach `Monitor` to its stdout. Each line is one JSON event. Stderr is pino logs — don't act on it.

### Codex

```
shell(command: "METRO_CODEX_RC=ws://127.0.0.1:8421 metro", run_in_background: true)
```

Codex has no Monitor equivalent. Instead, metro pushes each event into your thread via JSON-RPC `turn/start`, so events arrive as user input on your next turn. The user must have a daemon + TUI running on the **same WebSocket URL**:

```
codex app-server --listen ws://127.0.0.1:8421     # daemon (terminal 1)
codex --remote ws://127.0.0.1:8421                # TUI (terminal 2) — type "hi" once to create a live thread
```

Then metro starts third. If metro exits immediately or you see `thread not found` retries on its stderr, the TUI didn't create a thread yet — tell the user to type something in the TUI.

### Diagnostics

If something seems off, run `metro doctor`. Common causes: missing tokens (`metro setup telegram <token>` / `metro setup discord <token>`), Discord Message Content Intent not toggled, stale lockfile, or (Codex) no live thread on the daemon.

## Event shape

Every line on stdout is one **history entry** — the same record appended to `history.jsonl`. Fields:
- `kind` — `"inbound"`, `"outbound"`, or `"notification"`
- `id` (`msg_…`) — universal message ID minted by metro
- `ts` — ISO timestamp
- `station` — `"discord"`, `"telegram"`, `"claude"`, `"codex"`
- `line` — conversation URI; `lineName?` is the channel/topic display name
- `from` / `fromName?` — sender participant URI + optional display name
- `to` — recipient participant URI (agent for inbound, line for notification)
- `text` — the literal text content (Telegram `text`/`caption`, Discord `content`). May be empty for attachment-only messages — inspect `payload` for everything else.
- `messageId?` — platform-side id (Discord snowflake, Telegram int). Set on inbound.
- `payload?` — raw platform-native message object. Set on inbound only. Shape varies per `station`.

```json
{"kind":"inbound","id":"msg_aB3xY7zP","ts":"2026-05-14T12:00:00Z","station":"telegram","line":"metro://telegram/-100…/247","lineName":"infra","from":"metro://telegram/user/12345","fromName":"@alice","to":"metro://claude/agent","messageId":"4567","text":"hi","payload":{"message_id":4567,"chat":{"id":-100,"type":"supergroup","is_forum":true},"from":{"id":12345,"username":"alice"},"text":"hi","photo":[{"file_id":"…"}],"reply_to_message":{"message_id":4500,"text":"earlier","from":{"id":99,"username":"bob"}}}}
```

```json
{"kind":"notification","id":"msg_pQ4r5sT0","ts":"…","station":"claude","line":"metro://claude/deploys","from":"metro://codex/ci","to":"metro://claude/deploys","text":"deploy green"}
```

### `payload` by station

`payload` is the platform's native message shape. Narrow on `event.station`:

- **`discord`** — discord.js `Message.toJSON()`: camelCase fields (`channelId`, `guildId`, `content`, `author`, `mentions: { users[], roles[], everyone }`, `attachments[]`, `reference`, …). Most collections come back as **arrays of IDs**; `attachments[]` is grafted to full objects (`{ id, name, url, contentType, size, ... }`). `referencedMessage` is added inline on replies (auto-fetched).
- **`telegram`** — raw Bot API `Message` (snake_case): `{ message_id, chat, from, text, caption, entities[], photo[], document, voice, audio, reply_to_message, … }`. `reply_to_message` is inline on replies.

Use `payload` for anything the envelope doesn't surface — mentions, reply chains, embeds, entities.

## Detecting "is this for me?"

Derive from `payload`. Bot id per station is cached in `$METRO_STATE_DIR/bot-ids.json` (`{discord:"<userId>", telegram:"<userId>"}`, written by the daemon on start).

- **discord** — DM when `payload.guildId == null`; otherwise pinged when `payload.mentions.users.includes(<bot-id>)`.
- **telegram** — DM when `payload.chat.type === 'private'`; otherwise pinged when any entity in `payload.entities` (or `caption_entities`) is `{type:"mention"}` matching `@<bot-username>` or `{type:"text_mention", user:{id:<bot-id>}}`.

Default: only reply on DM or ping; otherwise stay silent.

Both `from` and `to` are **participant URIs** (the conversation context lives in `line`):
- `metro://<station>/user/<id>` — a person on a chat platform
- `metro://claude/<topic>` / `metro://codex/<topic>` — an agent

The `id` is the **canonical handle** for that message across all stations — store it if you want to refer back to it later.

- `kind: "inbound"` — a human (or another bot) posted on a chat platform.
- `kind: "notification"` — another agent called `metro notify` against your agent line. This is how Codex pings Claude Code and vice versa.

Attachments live on `payload`, not in `text`. Telegram shows `photo[]`, `document`, `voice`, `audio`; Discord shows `attachments[]` (with `contentType`). Use `metro download` to materialize images to disk.

## Required flow on every event

1. **Echo to your visible output**: `[<line>#<messageId>] <text>` on its own line. Both Claude Code's Monitor and Codex collapse tool output, so this echo is the only way the user sees what arrived without expanding cards.
2. **Decide and act** using `metro raw` (or one of the helpers below).

## Sending messages — `metro raw`

There is no `metro send` / `metro reply` / `metro edit` / `metro react`. To send, edit, react, or do anything the platform supports, you call its native REST API through `metro raw`:

```
metro raw <station> <method> <path> [--body=<json>]
```

`<station>` is `discord` or `telegram`. The daemon attaches auth automatically — no token in your call. `--body` can also come from stdin (heredoc) for multi-line payloads.

### Telegram

Base URL: `https://api.telegram.org/bot<TOKEN>`. See the [Bot API docs](https://core.telegram.org/bots/api).

```bash
# Send a fresh message
metro raw telegram POST /sendMessage --body='{"chat_id":25220238,"text":"hello"}'

# Reply (threaded)
metro raw telegram POST /sendMessage --body='{"chat_id":25220238,"text":"ack","reply_parameters":{"message_id":641}}'

# Edit
metro raw telegram POST /editMessageText --body='{"chat_id":25220238,"message_id":642,"text":"updated"}'

# React
metro raw telegram POST /setMessageReaction --body='{"chat_id":25220238,"message_id":641,"reaction":[{"type":"emoji","emoji":"👍"}]}'

# Topic / forum reply: include "message_thread_id" in the body
```

The `chat_id` comes from `payload.chat.id` on the inbound. Topic id from `payload.message_thread_id`. Reply target from `payload.message_id`.

### Discord

Base URL: `https://discord.com/api/v10`. See the [Discord REST docs](https://discord.com/developers/docs/reference).

```bash
# Send to a channel
metro raw discord POST /channels/1504226489359401221/messages --body='{"content":"hello"}'

# Reply (threaded)
metro raw discord POST /channels/<channelId>/messages --body='{"content":"ack","message_reference":{"message_id":"<id>"}}'

# Edit
metro raw discord PATCH /channels/<channelId>/messages/<messageId> --body='{"content":"updated"}'

# React
metro raw discord PUT /channels/<channelId>/messages/<messageId>/reactions/%F0%9F%91%8D/@me
```

The `channelId` comes from `payload.channelId` on the inbound. Reply target from `payload.id`. `flags: 4` (1 << 2) suppresses link previews if you want that.

### Heredoc for long bodies

```bash
metro raw discord POST /channels/123/messages --body="$(cat <<'EOF'
{"content":"line one\nline two\nline three"}
EOF
)"
```

### What `metro raw` does

1. Loads the station's bot token from the daemon's config.
2. Issues the request with the right base URL + auth header.
3. Prints the response (status line + JSON body). With `--json` you get `{"status":200,"ok":true,"body":{...}}`.
4. For write methods (POST/PATCH/PUT/DELETE), appends an `outbound` row to `history.jsonl` so the universal log stays unified.

It does **not** support multipart file uploads yet. For images and other files, host them somewhere and pass the URL (Discord and Telegram both accept URLs in the relevant endpoints).

## Other subcommands

| Command | Purpose |
|---|---|
| `metro notify <agent-line> <text>` | Ping another agent (`metro://claude/<topic>` or `metro://codex/<topic>`). |
| `metro download <line> <messageId> [--out=<dir>]` | Materialize image attachments to disk. |
| `metro fetch <line> [--limit=20]` | Recent-channel-history lookback (Discord only). |
| `metro history` | Read the universal message log. Filters: `--limit`, `--line`, `--station`, `--kind`, `--from`, `--text`, `--since`, `--json`. |
| `metro lines` | List recently-seen conversations. |
| `metro stations` | List stations + capabilities. |
| `metro doctor` | Health check. |

All commands accept `--json` for parseable output.

## Line URI scheme

`metro://<station>/<path>` — see [docs/uri-scheme.md](https://github.com/bonustrack/metro/blob/main/docs/uri-scheme.md) for the full grammar.

| Station    | Pattern                                   | Example                              |
|------------|-------------------------------------------|--------------------------------------|
| `discord`  | `metro://discord/<channel-id>`            | `metro://discord/1234567890`         |
| `telegram` | `metro://telegram/<chat-id>[/<topic-id>]` | `metro://telegram/-1001234567890/42` |
| `claude`   | `metro://claude/<topic>`                  | `metro://claude/deploys`             |
| `codex`    | `metro://codex/<topic>`                   | `metro://codex/ci`                   |

## Image attachments

When `payload.photo` (Telegram) or `payload.attachments[].contentType?.startsWith('image/')` (Discord) is present:

1. `metro download <line> <messageId>` — writes images to disk and prints absolute paths.
2. `Read` each path with your Read tool — the image enters your context as a vision input.
3. Reply via `metro raw`.

Non-image attachments are not materialized by `metro download` — inspect `payload` for the file metadata. On Discord the full attachment objects (with `url`) are on `payload.attachments`. On Telegram you have `voice.file_id` / `document.file_id` and can resolve to a URL via `metro raw telegram POST /getFile --body='{"file_id":"..."}'`.

## Cross-agent notification

Use `metro notify` to ping another agent's "agent line":

```bash
metro notify metro://claude/deploys "build green, ready to ship"
metro notify metro://codex/ci "build green" --from=metro://claude/deploys   # override sender
```

The daemon re-emits the post on its stdout stream (and pushes via codex-rc if configured), so the peer agent sees a `{"kind":"notification",...}` event. Requires the metro daemon to be running on the machine.

## Identity stamping

When you call `metro raw` or `metro notify`, the outbound history row's `from` is auto-stamped to `metro://claude/agent` (from `$CLAUDECODE`) or `metro://codex/agent` (from `$METRO_CODEX_RC` / `$CODEX_HOME`). Override with `--from=<uri>` or `$METRO_FROM`.

## Exit codes

- `0` success
- `1` usage error (bad args, unknown subcommand, malformed `--body`)
- `2` configuration error (no tokens — tell the user to run `metro setup`)
- `3` upstream error (rate limit, auth, network)

## Don'ts

- ❌ Spawning a second metro daemon — there's one per machine (lockfile-enforced).
- ❌ Calling the Telegram or Discord API directly with your own HTTP client. Use `metro raw` so the daemon manages auth and history logging.
- ❌ Narrating the tool ("I'll now use metro raw to…"). The tool call is already visible to the user.
