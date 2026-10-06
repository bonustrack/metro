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
- Channel discovery with `list_channels {station: "telegram", account, query?, limit?, cursor?}`.

### Channel discovery

An explicit attached account is required. Discovery lists its Telegram dialogs from
MTProto, including pinned and archived chats, without relying on recently received
Metro messages. It does not expand contacts, create chats, or enumerate forum topics
or members. Broadcast channels have kind `channel`, users `direct`, and other chats
`group`. Each entry contains only `id`, the account-scoped `line`, `kind`, and an
available display `name`. No message bodies, avatars, or member data are returned.

`query` searches names, ids, and lines case-insensitively, up to 200 characters.
`limit` defaults to 50 and accepts 1 to 100. Results are deduplicated and sorted by
line. Follow `next_cursor` with the same account and query for the next page of the
snapshot. Cursors expire after five minutes and disappear when the train restarts.

The source is `remote`. Pinned dialogs in the normal and archived folders are fetched
separately, then unpinned dialogs are paged with both folders included. The scan stops
after at most 5,001 dialogs and the shared directory retains at most 5,000 entries
within its metadata size limit. `capability.complete` is false when another page is
available or a bound was reached; a partial scan remains partial on its last page.
Search covers only that bounded snapshot. A 30-second scan budget is checked between
yielded dialogs and before each folder scan, with a partial result when reached.
An SDK request already in flight cannot be cancelled here and can exceed that budget.
MTProto dialog responses also carry their latest messages; the SDK uses their ids
and dates for pagination. Metro projects only the channel metadata above and does
not call message history or profile endpoints for discovery.

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
