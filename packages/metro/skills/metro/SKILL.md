---
name: metro
description: Run the metro Telegram/Discord/webhook relay in this session — launch `metro` in the background, watch its stdout for inbound JSON events, and act on each. Use when the user asks to start/run/launch metro, when you see JSON lines on stdout shaped `{"kind":"inbound","station":...,"line":"metro://...","messageId":...,"text":...}`, or when handling a chat/webhook reply/edit/react/send/download.
---

# Metro — Telegram / Discord / webhook relay

Metro is a CLI relay between this session and external sources: Telegram, Discord, and HTTP webhooks (GitHub, Intercom, Fireflies, …). You launch `metro` once, then act on each inbound JSON line by calling `metro call <station> <METHOD> <path> [body]`.

## Starting metro

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

Codex has no Monitor equivalent. Instead, metro pushes each event into your thread via JSON-RPC `turn/start`, so events arrive as user input on your next turn. The user must have a daemon + TUI running on the same WebSocket URL:

```
codex app-server --listen ws://127.0.0.1:8421     # daemon (terminal 1)
codex --remote ws://127.0.0.1:8421                # TUI (terminal 2) — type "hi" once to create a live thread
```

If metro exits immediately or prints `thread not found` retries on stderr, the TUI hasn't created a thread yet — tell the user to type something in the TUI.

### Diagnostics

If something seems off, run `metro doctor`. Common causes: missing tokens (`metro setup telegram <token>` / `metro setup discord <token>`), Discord Message Content Intent not toggled, stale lockfile, or (Codex) no live thread on the daemon.

## Event shape

Every line on stdout is one **history entry** — same record appended to `history.jsonl`. Fields:

- `kind` — `"inbound"`, `"outbound"`, `"edit"`, `"react"`. Inbound `react` events fire when a human adds an emoji reaction in Discord/Telegram — `emoji` is set, `text` is omitted, `messageId` is the message that got reacted to.
- `id` (`msg_…`) — universal metro ID, minted by the dispatcher.
- `ts` — ISO timestamp from the transport.
- `station` — `"discord"`, `"telegram"`, `"claude"`, `"codex"`, `"webhook"`.
- `line` — conversation URI; `lineName?` is the channel/topic display name (for webhooks: the label you gave it).
- `from` / `fromName?` — sender participant URI + optional display name.
- `to` — recipient participant URI (local user for DMs, conversation `line` for groups).
- `text` — universal display projection. Includes `[image]` / `[file: …]` / `[voice]` / `[audio]` inline.
- `messageId?` — platform-side id (Discord snowflake, Telegram int). Distinct from universal `id`.
- `payload?` — raw platform-native message object. Set on inbound. Shape varies per `station`.
- `display?` — pre-rendered chat-bubble markdown (bold header + blockquote body). Echo this verbatim.

```json
{"kind":"inbound","id":"msg_aB3xY7zP","ts":"2026-05-17T12:00:00Z","station":"telegram","line":"metro://telegram/-100…/247","lineName":"infra","from":"metro://telegram/user/12345","fromName":"@alice","to":"metro://claude/user/9bfc7af0-…","messageId":"4567","text":"hi [image]","payload":{"message_id":4567,"chat":{"id":-100,"type":"supergroup"},"from":{"id":12345,"username":"alice"},"text":"hi","photo":[{"file_id":"…"}],"reply_to_message":{"message_id":4500,"text":"earlier","from":{"id":99,"username":"bob"}}}}
```

### `payload` by station

`payload` is the platform's native shape. Narrow on `event.station`:

- **`discord`** — discord.js `Message.toJSON()` (camelCase): `channelId`, `guildId`, `content`, `author`, `mentions: { users[], roles[], everyone }`, `attachments[]`, `reference`, `channelName?` (added by the transport for `lineName`), `referencedMessage?` (auto-fetched on replies). For reactions: `{ channelId, guildId, messageId, userId, username, bot, emoji: { name, id, animated } }`.
- **`telegram`** — raw Bot API `Message` (snake_case): `{ message_id, chat, from, text, caption, entities[], photo[], document, voice, audio, reply_to_message, message_thread_id, is_topic_message, … }`. For reactions: `MessageReactionUpdated`.
- **`webhook`** — `{ endpointId, label, method, url, headers, body }`. Provider lives in headers like `x-github-event`, `x-intercom-topic`. Full event payload is `body` (parsed JSON when possible).

Use `payload` for anything the envelope doesn't surface — mentions, reply chains, embeds, entities, image URLs.

## Detecting "is this for me?"

Derive from `payload`. Bot id per station is cached in `$METRO_STATE_DIR/bot-ids.json` (`{discord:"<userId>", telegram:"<userId>"}`, written by the daemon on start).

- **discord** — DM when `payload.guildId == null`; otherwise pinged when `payload.mentions.users` contains the bot id, or `payload.mentions.everyone === true`.
- **telegram** — DM when `payload.chat.type === 'private'`; otherwise pinged when any entity in `payload.entities` (or `caption_entities`) is `{type:"mention"}` matching `@<bot-username>` or `{type:"text_mention", user:{id:<bot-id>}}`.
- **webhook** — every POST is "for you" by design. Route on `payload.headers['x-github-event']` / `x-intercom-topic` etc. to decide which provider event you're handling.

Default for chat: only reply on DM or ping; otherwise stay silent or react to ack. Webhooks have no "ack" mechanism — just consume the event.

## Required flow on every event

1. **Echo `event.display` verbatim as your first chat output.** Every event ships a pre-rendered chat-bubble in `event.display`. Render it as-is, before any commentary or tool calls. Example:

   ```
   **📩 telegram · @bonustrack**
   > Hey
   ```

2. **Decide and act** using `metro call` below.

## The `metro call` contract

```
metro call <station> <METHOD> <path> [body-json | @file | -]
```

`station` = `discord` | `telegram`. `path` is the platform-native path (e.g. `/channels/<id>/messages`). `body` is JSON: a literal, `@/path/to/body.json`, or `-` for stdin (use the latter for multi-line content via heredoc).

The CLI auto-applies the per-station base URL + auth — you never write tokens or `https://...` URLs.

### Discord recipes

```bash
# Reply to a message (threaded under it)
metro call discord POST /channels/<channelId>/messages '{
  "content": "ack",
  "message_reference": { "message_id": "<messageId>" }
}'

# Fresh send
metro call discord POST /channels/<channelId>/messages '{"content":"build green"}'

# Edit a previous outbound (use the messageId from your own outbound history entry)
metro call discord PATCH /channels/<channelId>/messages/<messageId> '{"content":"updated"}'

# Add a reaction
metro call discord PUT '/channels/<channelId>/messages/<messageId>/reactions/%F0%9F%91%80/@me'
# (the emoji must be URL-encoded; 👀 = %F0%9F%91%80)

# Remove your own reaction
metro call discord DELETE '/channels/<channelId>/messages/<messageId>/reactions/%F0%9F%91%80/@me'

# Suppress link previews on a fresh send (flags = 1 << 2)
metro call discord POST /channels/<channelId>/messages '{"content":"hi","flags":4}'

# URL buttons (action row of style-5 link buttons)
metro call discord POST /channels/<channelId>/messages '{
  "content":"approve?",
  "components":[{"type":1,"components":[
    {"type":2,"style":5,"label":"Open PR","url":"https://github.com/x/y/pull/1"}
  ]}]
}'
```

### Telegram recipes

```bash
# Send a fresh message
metro call telegram POST /sendMessage '{"chat_id":-1003950444088,"text":"build green"}'

# Reply (threaded under the original)
metro call telegram POST /sendMessage '{
  "chat_id": -1003950444088,
  "text": "ack",
  "reply_parameters": { "message_id": 4567 }
}'

# Edit a message you sent earlier
metro call telegram POST /editMessageText '{
  "chat_id": -1003950444088,
  "message_id": 4567,
  "text": "updated"
}'

# Add a reaction
metro call telegram POST /setMessageReaction '{
  "chat_id": -1003950444088,
  "message_id": 4567,
  "reaction": [{ "type": "emoji", "emoji": "👀" }]
}'

# Clear a reaction (empty array)
metro call telegram POST /setMessageReaction '{
  "chat_id": -1003950444088,
  "message_id": 4567,
  "reaction": []
}'

# Inline URL button keyboard
metro call telegram POST /sendMessage '{
  "chat_id": -100…, "text": "approve?",
  "reply_markup": { "inline_keyboard": [[
    { "text": "Open PR", "url": "https://github.com/x/y/pull/1" }
  ]] }
}'

# Forum topic: include message_thread_id (= the topic id from the line)
metro call telegram POST /sendMessage '{
  "chat_id": -1003950444088, "message_thread_id": 247, "text": "in-topic"
}'

# Multi-line text: pipe stdin with -
printf '%s' '{"chat_id":123,"text":"line one\nline two"}' \
  | metro call telegram POST /sendMessage -
```

### File uploads (multipart)

`metro call` doesn't take an `--image` flag — `application/json` only. For image / document / voice uploads, build the multipart request directly with `curl`:

```bash
# Telegram photo upload (single image)
curl -fsS https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendPhoto \
  -F chat_id=-1003950444088 \
  -F photo=@/tmp/build.png \
  -F caption='build green'

# Discord image upload (attachments + payload_json)
curl -fsS -X POST https://discord.com/api/v10/channels/<channelId>/messages \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -F payload_json='{"content":"screenshot"}' \
  -F files[0]=@/tmp/build.png
```

The tokens are in your `~/.config/metro/.env` (and exported by metro). `discord call`/`telegram call` will gain a `--form` mode if this becomes a hot path.

### Downloading attachments

For Discord, `payload.attachments[]` carries `url` — fetch directly:

```bash
curl -fsSL -o /tmp/img.png "$(echo '<payload>' | jq -r '.attachments[0].url')"
```

For Telegram, the image is a `file_id`. Two-step:

```bash
metro call telegram POST /getFile '{"file_id":"<file_id>"}'
# → { "file_path": "photos/file_42.jpg", ... }
curl -fsSL -o /tmp/img.jpg "https://api.telegram.org/file/bot$TELEGRAM_BOT_TOKEN/photos/file_42.jpg"
```

Then `Read` the file to bring it into context, and reply.

## Editing the adapter (`~/.metro/adapters/<station>/map.ts`)

Each station has a `map(raw, metro) → envelope | null` function. `raw` is `{ station, kind, ts, payload }`; `envelope` is the partial inbound shape (the dispatcher fills in `id`, `ts`, history fields).

The daemon hot-reloads on save — no restart needed. Return `null` to drop a raw event (it'll be quarantined to `$METRO_STATE_DIR/unmatched/<station>/<id>.json`).

Add a field:

```js
// ~/.metro/adapters/discord/map.ts
function mapMessage(m) {
  // ...existing projection...
  return {
    kind: 'inbound',
    line: `metro://discord/${m.channelId}`,
    // ↓ surface mention count for the agent
    text: m.mentions?.users?.length
      ? `[mentions:${m.mentions.users.length}] ${m.content}`
      : m.content,
    from: `metro://discord/user/${m.author.id}`,
    fromName: m.author.username,
    messageId: m.id,
    isPrivate: m.guildId == null,
  };
}
```

Handle a new payload variant (Telegram poll, Discord thread, …) by adding a branch to `map()` and returning an envelope. If the platform's API surfaces a new field you need on every event, add it to `payload` via the transport (one-line change to `src/transports/<station>.ts`) — but most cases can be solved from `payload` alone since transports pass it through verbatim.

## Line URI scheme

`metro://<station>/<path>` — see `docs/uri-scheme.md` for the full grammar.

| Station    | Pattern                                   | Example                                |
|------------|-------------------------------------------|----------------------------------------|
| `discord`  | `metro://discord/<channel-id>`            | `metro://discord/1234567890`           |
| `telegram` | `metro://telegram/<chat-id>[/<topic-id>]` | `metro://telegram/-1001234567890/42`   |
| `claude`   | `metro://claude/<user-id>/<session-id>`   | `metro://claude/9bfc7af0-…/50b00d11-…` |
| `codex`    | `metro://codex/<user-id>/<session-id>`    | `metro://codex/8119ecb1-…/01997d4b-…`  |
| `webhook`  | `metro://webhook/<endpoint-id>`           | `metro://webhook/fwaCgTKJuLAjS2K0`     |

`messageId` is not part of the URI — keep it as a separate value when chaining requests.

## Discoverability

- `metro lines` — list recently-seen conversations (sorted by recency).
- `metro stations` — list configured stations.
- `metro history --limit=N --line=… --station=… --kind=… --from=… --text=…`
  Universal log (every inbound + outbound + edit + react). Newest first. Add `--json` for machine-parseable.
- `metro adapters list` — print which `map.ts` files are installed.
- `metro adapters install` — copy missing templates from the repo to `~/.metro/adapters/`.

## Exit codes

- `0` success
- `1` usage error
- `2` configuration error (no tokens — tell the user to run `metro setup`)
- `3` upstream error (rate limit, auth, network) — retry once after a few seconds before surfacing.

## Don'ts

- Don't spawn a second metro daemon — there's one per machine (lockfile-enforced).
- Don't narrate the tool ("I'll now use metro call to…"). The tool call is already visible.
- Don't post to a line that isn't in `metro lines` unless the user gave it to you explicitly.
- Don't edit `~/.metro/adapters/<station>/map.ts` to add CLI verbs — keep `map()` pure (project events only). Outbound goes through `metro call`.
