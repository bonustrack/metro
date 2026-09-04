# @metro-labs/telegram

> The Metro **telegram** station: bridges Telegram via a **user account** (MTProto)
> into the core daemon. Distinct from the bot-API station `@metro-labs/telegram-bot`.

Private station package (part of the [Metro monorepo](../../README.md)). It depends on
`@metro-labs/mcp` and `@mtcute/bun` (MTProto client) and implements the station contract
from `@metro-labs/mcp/stations/*`. The core consumes it two ways:

- as a **descriptor** — the `.` export (`station.ts` → `telegramStation`), read by the
  core registry to route lines/verbs;
- as a **train subprocess** — the `./train` export (`index.ts`), spawned by the
  supervisor to run the live user session(s).

Lines are account-scoped — `metro://telegram/<account>/<peer>` — so replies go back
out the same user identity.

## Status

**Registered.** Wired into the core registry. The descriptor always surfaces in
`tools/list`; the train subprocess only spawns when a `telegram` account exists in
the DB. With none the station is dormant — calls return a "no accounts" error, like any
other unconfigured station.

## Capabilities

- Message verbs: `send`, `reply`, `react`, `unreact`, `edit`, `delete`, `read`.
- Attachments normalized to the canonical form.
- Inbound updates over the MTProto event stream via `@mtcute/bun`.

## Configuration

Each user session is a `telegram` account row in the DB with
`{ session, apiId, apiHash }` in `accounts.config` jsonb; optional `owner`. The daemon
materializes it to the accounts file the train reads. See the
[root README "Configuration"](../../README.md#configuration). The session string is
produced by the interactive attach in the web UI, which signs the account in over MTProto.

| Env var | Meaning |
| --- | --- |
| `TELEGRAM_ACCOUNTS_FILE` | Optional override for the materialized accounts file path |


## Local testing

Generate a session against your own Telegram account, put it in a local Postgres, and
run the daemon:

1. **Get `api_id` / `api_hash`** from [my.telegram.org](https://my.telegram.org)
   → *API development tools*.
2. **Attach the account** from the web UI (*Connect station* → Telegram): the interactive
   attach signs in over MTProto and stores the session in the account's `config`.

3. Run `bun run start`. Send yourself a Telegram message and watch the inbound
   `metro://telegram/default/<peer>` event in the logs.

## Constraints

- **Telegram ToS.** A user account is a real person's identity; automation must respect
  Telegram's terms and rate limits to avoid bans.
- **Session secret.** `TELEGRAM_SESSION` is a full login credential — treat it like a
  password; never log or commit it.
- **Single-writer.** Only one process may run a given user session at a time; a second
  concurrent writer risks session invalidation. Run exactly one instance per account.
