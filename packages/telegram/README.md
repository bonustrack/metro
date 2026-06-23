# @metro-labs/telegram

> The Metro **telegram** station: bridges the Telegram Bot API into the core daemon.

Private station package (part of the [Metro monorepo](../../README.md)). It depends only
on `@metro-labs/mcp` and implements the station contract from
`@metro-labs/mcp/stations/*`. The core consumes it two ways:

- as a **descriptor** — the `.` export (`station.ts` → `telegramStation`), read by the
  core registry to route lines/verbs;
- as a **train subprocess** — the `./train` export (`index.ts`), spawned by the
  supervisor to run the live bot(s).

One or many bots from a comma-separated token list, each its own account (ids `t0..tN`).
Lines are account-scoped — `metro://telegram/<account>/<chat>` — so replies go back out
the same bot identity.

## Capabilities

- Message verbs: `send`, `reply`, `react`, `unreact`, `edit`, `delete` (no `read`).
- Media send via the Bot API (`media-actions.ts`); attachments are normalized to the
  canonical form (`attachments.ts`). Inbound updates arrive via long-poll (`wire.ts`).

## Env vars

| Var | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKENS` | **Required.** Comma-separated bot tokens (from @BotFather) → one bot each |
| `TELEGRAM_ACCOUNTS_FILE` | Optional path to an accounts file (overrides the token list) |

No persistent state of its own — Telegram is server-side, so this station is safe to
restart at will (unlike XMTP).
