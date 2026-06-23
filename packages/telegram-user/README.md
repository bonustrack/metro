# @metro-labs/telegram-user

> The Metro **telegram-user** station: bridges Telegram via a **user account** (MTProto)
> into the core daemon. Distinct from the bot-API station `@metro-labs/telegram`.

Private station package (part of the [Metro monorepo](../../README.md)). It depends on
`@metro-labs/mcp` and `@mtcute/bun` (MTProto client) and implements the station contract
from `@metro-labs/mcp/stations/*`. The core consumes it two ways:

- as a **descriptor** — the `.` export (`station.ts` → `telegramUserStation`), read by the
  core registry to route lines/verbs;
- as a **train subprocess** — the `./train` export (`index.ts`), spawned by the
  supervisor to run the live user session(s).

Lines are account-scoped — `metro://telegram-user/<account>/<peer>` — so replies go back
out the same user identity.

## Status

**WIP — scaffold only.** This package is not yet wired into the core registry or Docker
entrypoint, so it does not deploy or run. The train entry typechecks but does not open a
Telegram connection; every call currently responds with a `not_implemented` `TrainError`.
Real handlers land in later PRs (auth/login → inbound → outbound → attachments+read →
register+docker).

## Capabilities (planned)

- Message verbs: `send`, `reply`, `react`, `unreact`, `edit`, `delete`, `read`.
- Attachments normalized to the canonical form.
- Inbound updates over the MTProto event stream via `@mtcute/bun`.

## Env vars (planned)

| Var | Meaning |
| --- | --- |
| `TELEGRAM_USER_API_ID` | Telegram API id (from my.telegram.org) |
| `TELEGRAM_USER_API_HASH` | Telegram API hash |
| `TELEGRAM_USER_SESSION` | Serialized MTProto session string (the login secret) |
| `TELEGRAM_USER_ACCOUNTS` | Configures the set of user accounts |
| `TELEGRAM_USER_ONLY_ACCOUNTS` | Restricts to an allowlisted subset |

## Constraints

- **Telegram ToS.** A user account is a real person's identity; automation must respect
  Telegram's terms and rate limits to avoid bans.
- **Session secret.** `TELEGRAM_USER_SESSION` is a full login credential — treat it like a
  password; never log or commit it.
- **Single-writer.** Only one process may run a given user session at a time; a second
  concurrent writer risks session invalidation. Run exactly one instance per account.
