# @metro-labs/telegram-bot

> The Metro **telegram-bot** station: bridges the Telegram Bot API into the core daemon.

Private station package (part of the [Metro monorepo](../../README.md)). It depends only
on `@metro-labs/mcp` and implements the station contract from
`@metro-labs/mcp/stations/*`. The core consumes it two ways:

- as a **descriptor** — the `.` export (`station.ts` → `telegramBotStation`), read by the
  core registry to route lines/verbs;
- as a **train subprocess** — the `./train` export (`index.ts`), spawned by the
  supervisor to run the live bot(s).

One or many bots, each a `telegram-bot` account row in the DB (ids `t0..tN`).
Lines are account-scoped — `metro://telegram-bot/<account>/<chat>` — so replies go back out
the same bot identity.

## Capabilities

- Message verbs: `send`, `reply`, `react`, `unreact`, `edit`, `delete` (no `read`).
- Media send via the Bot API (`media-actions.ts`); attachments are normalized to the
  canonical form (`attachments.ts`). Inbound updates arrive via long-poll (`wire.ts`).

## Configuration

Each bot is a `telegram-bot` account row in the DB with `{ token }` (from @BotFather) in
`accounts.config` jsonb; optional `owner`. The daemon materializes it to the accounts
file the train reads. See the [root README "Configuration"](../../README.md#configuration).

| Env var | Meaning |
| --- | --- |
| `TELEGRAM_BOT_ONLY_ACCOUNTS` / `TELEGRAM_BOT_ACCOUNTS` | Optional comma-separated `account_id` filter — boot only these accounts |
| `TELEGRAM_BOT_ACCOUNTS_FILE` | Optional override for the materialized accounts file path |

No persistent state of its own — Telegram is server-side, so this station is safe to
restart at will (unlike XMTP).
