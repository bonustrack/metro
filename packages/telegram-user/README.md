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

## Env vars

| Var | Meaning |
| --- | --- |
| `TELEGRAM_USER_API_ID` | Telegram API id (from my.telegram.org) |
| `TELEGRAM_USER_API_HASH` | Telegram API hash |
| `TELEGRAM_USER_SESSION` | Serialized MTProto session string (the login secret) |
| `TELEGRAM_USER_ACCOUNTS` | JSON array of `{ id, session, apiId, apiHash }` (multi-account) |
| `TELEGRAM_USER_ACCOUNTS_FILE` | Path to the accounts JSON file (default `~/.metro/telegram-user-accounts.json`) |
| `TELEGRAM_USER_ONLY_ACCOUNTS` | Comma-separated allowlist restricting which accounts boot |

Account resolution order: the accounts file (if present) → `TELEGRAM_USER_ACCOUNTS`
(JSON array) → the single-account fast path (`TELEGRAM_USER_SESSION` +
`TELEGRAM_USER_API_ID` + `TELEGRAM_USER_API_HASH`, registered as the `default` account).

## Login (out-of-band)

`TELEGRAM_USER_SESSION` is produced once, locally, by the maintainer — never in prod.
`scripts/login.ts` is a dev tool (not part of the train); it runs the interactive
MTProto sign-in (phone → code → optional 2FA password) and prints the session string.

```sh
export TELEGRAM_USER_API_ID=...      # from my.telegram.org
export TELEGRAM_USER_API_HASH=...
bun packages/telegram-user/scripts/login.ts
# follow the prompts, then store the printed session as a Fly secret:
fly secrets set TELEGRAM_USER_SESSION="<session>" -a metro
```

The login client uses in-memory storage, so nothing is written to disk locally. Treat the
printed session like a password: it is a full login credential. Never commit or log it.

## Constraints

- **Telegram ToS.** A user account is a real person's identity; automation must respect
  Telegram's terms and rate limits to avoid bans.
- **Session secret.** `TELEGRAM_USER_SESSION` is a full login credential — treat it like a
  password; never log or commit it.
- **Single-writer.** Only one process may run a given user session at a time; a second
  concurrent writer risks session invalidation. Run exactly one instance per account.
