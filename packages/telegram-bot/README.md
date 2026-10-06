# @metro-labs/telegram-bot

The Metro **telegram-bot** station bridges the Telegram Bot API into the local daemon.
It depends only on `@metro-labs/core` and exports a station descriptor (`station.ts`)
and a train subprocess (`index.ts`). Each attached bot has its own account and token.

Lines are account-scoped: `metro://telegram-bot/<account>/<chat>`. Forum topics use
`metro://telegram-bot/<account>/<chat>/<topic>`. Replies use the same bot identity.

## Capabilities

- Message verbs: `send`, `reply`, `react`, `unreact`, `edit`, `delete`, `typing`.
- Media send via the Bot API, with canonical attachment handling.
- Inbound messages and reactions through long-polling.
- Profile lookup and changes, and an incomplete administrator-only member list.
- Metadata-only channel discovery through `list_channels` (train action `listChannels`).
  An explicit attached `account` is required, even when there is only one bot.

## Channel discovery

Telegram's Bot API has no all-chats API. Discovery returns only chat and topic metadata
this bot has observed on this box, not a contact roster or an exhaustive list of chats.
The capability always reports `supported: true`, `complete: false`, `source: "local"`,
with a reason explaining missing, unobserved updates and the 5,000-entry limit.

Observed message/reaction chat objects and `my_chat_member` updates supply chat IDs,
names and kinds. Channel posts supply metadata only: this does not add channel-post
message or media delivery. Topic names come only from forum-topic service metadata,
never from message text. No message bodies, media, member rosters or sender profiles
are stored in the directory. A leave, kick, or non-member restriction removes the chat
and its topics; group migrations remove the old chat and topic lines.

Each result contains only `id`, canonical `line`, optional `name`, and `kind`
(`direct`, `group`, `channel`, or `thread`). The shared core directory handles
case-insensitive `query` matching on ID, line and name, `limit` (1 to 100, default 50),
and bounded snapshot pagination. Follow `next_cursor` as `cursor` with the same account
and query; start a new listing when a cursor expires. Finishing pagination does not
make the observed directory exhaustive. Listing makes no Telegram API calls and does
not change Receive messages, allowlists or tool policy.

## Configuration and storage

The daemon materializes attached bot configs `{ id, token }` into the accounts file.
See the [root README](../../README.md#configuration) for attachment and configuration.

| Env var | Meaning |
| --- | --- |
| `TELEGRAM_BOT_ACCOUNTS_FILE` | Override for the materialized accounts file path |
| `TELEGRAM_BOT_STATE_DIR` | Observed metadata directory, default `~/.metro` |

Metadata survives restarts in `telegram-bot-channels-<account>.json`, written with
mode `0600`. Changes are saved after a short debounce, so abrupt termination can lose
recent observations. At most 5,000 chat/topic entries are retained per bot, with names
limited to 256 characters. Detaching an account removes its file (`forget`), and boot
removes files for accounts no longer attached (`forgetExcept`). Telegram history is
not downloaded or persisted by discovery.
