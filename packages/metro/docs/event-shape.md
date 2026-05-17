# Metro event shape

Every event metro emits on stdout is one JSON line matching `HistoryEntry`
(see `src/history.ts`). This doc enumerates the `kind` values and the
station -> kind mapping. Metro is a dumb relayer — it forwards what each
platform gave it and lets consumers project.

## `kind` values

| `kind`     | When                                                                  | Notes                                                                |
|------------|-----------------------------------------------------------------------|----------------------------------------------------------------------|
| `inbound`  | Someone (not the metro bot) sent a message on a chat station          | `payload` = station-native message verbatim                          |
| `outbound` | The local user sent via `metro reply` / `metro send`                  | No `payload` (we already know what we sent)                          |
| `edit`     | Upstream message was edited or deleted                                | Deletes carry `text: ''` and `deleted: true`                         |
| `react`    | Someone added an emoji reaction, or cleared theirs                    | `emoji: ''` = cleared (consistent with outbound `metro react x msg ""`) |

The envelope shape (`HistoryEntry`) is the same for every `kind`. Consumers
that need platform-specific details narrow on `station` and read `payload`.

## Per-station event mapping

### Discord (`station: 'discord'`)

| Gateway event              | Metro `kind` | `text`                         | Notes                                              |
|----------------------------|--------------|--------------------------------|----------------------------------------------------|
| `messageCreate`            | `inbound`    | `payload.content` (or `''`)    | Bot self-messages dropped                          |
| `messageUpdate`            | `edit`       | new `payload.content`          | `deleted: false`                                   |
| `messageDelete`            | `edit`       | `''`                           | `deleted: true`, only `payload.id` is meaningful   |
| `messageReactionAdd`       | `react`      | n/a (carries `emoji`)          |                                                    |
| `messageReactionRemove`    | `react`      | n/a (carries `emoji: ''`)      | Same convention as `metro react <line> <msg> ''`   |

`payload` is always `Message.toJSON()` (and for replies, `referencedMessage`
is `fetchReference().toJSON()` grafted on as a sibling field).

### Telegram (`station: 'telegram'`)

`getUpdates.allowed_updates` is `['message', 'edited_message', 'channel_post',
'edited_channel_post', 'message_reaction']`. The default Bot API subset omits
`message_reaction`, so we list it explicitly. Other update types (chat_member,
chat_join_request, message_reaction_count) need a separate opt-in and are
deferred until a consumer needs them.

| Bot API update            | Metro `kind` | `text`                              | Notes                                       |
|---------------------------|--------------|-------------------------------------|---------------------------------------------|
| `message`                 | `inbound`    | `payload.text ?? payload.caption ?? ''` | Bot self-messages dropped               |
| `channel_post`            | `inbound`    | same                                | Channels (vs groups/DMs)                    |
| `edited_message`          | `edit`       | same                                |                                             |
| `edited_channel_post`     | `edit`       | same                                |                                             |
| `message_reaction`        | `react`      | n/a (carries `emoji`)               | `emoji: ''` when the user cleared theirs    |

`payload` is the raw Bot API `Message` (or `MessageReactionUpdated` for
reactions) verbatim - no slicing or projection.

## Consumer recipe: rendering a chat-bubble preview

Metro deliberately does not pre-render a display bubble. Consumers can build
one from `station + fromName + text` in one line:

```ts
const header = `**${e.station} - ${e.fromName ?? e.from}${e.lineName ? ` - ${e.lineName}` : ''}**`;
const body = e.text || (e.emoji ? `reacted ${e.emoji}` : '(no text)');
console.log(`${header}\n> ${body}`);
```

For media-only messages where `text` is empty, narrow on `payload`:

```jq
# Telegram sticker
select(.station == "telegram" and (.payload.sticker // empty))

# Telegram dice roll
select(.station == "telegram" and (.payload.dice // empty))

# Discord sticker-only message (no content)
select(.station == "discord" and (.payload.stickers | length) > 0)

# Discord deletes
select(.station == "discord" and .kind == "edit" and .deleted == true)

# Discord/Telegram attachments
select(.station == "discord" and (.payload.attachments | length) > 0)
select(.station == "telegram" and (.payload.photo // .payload.voice // .payload.document // empty))
```

Metro deliberately does not classify event subtypes upstream of the consumer
- if you need finer types than `kind`, derive them from `payload`.
