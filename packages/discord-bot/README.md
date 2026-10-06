# @metro-labs/discord-bot

> The Metro **discord-bot** station: bridges the Discord bot gateway + REST into the core
> daemon.

Private station package (part of the [Metro monorepo](../../README.md)). It depends on
`@metro-labs/mcp` (plus `discord.js`) and implements
the station contract from `@metro-labs/mcp/stations/*`. The core consumes it two ways:

- as a **descriptor** — the `.` export (`station.ts` → `discordBotStation`), read by the
  core registry to route lines/verbs;
- as a **train subprocess** — the `./train` export (`index.ts`), spawned by the
  supervisor to run the live bot(s).

One or many bots, each a `discord-bot` account row in the DB (ids `d0..dN`).
Lines are account-scoped (`metro://discord-bot/<account>/<channel>`).

## Capabilities

- Message verbs: `send`, `reply`, `react`, `unreact`, `edit`, `delete`, `read`.
- Attachments normalized to canonical form (`attachments.ts`).
- Channel discovery through the `listChannels` train action. An explicit bot
  `account` is required, with optional `query`, `limit` (default 50, maximum 100),
  and `cursor` from the preceding page's `next_cursor`. Search matches channel
  names, IDs and canonical lines, case-insensitively. Cursors expire after five
  minutes and belong to one account and query.

### Channel discovery

Discovery lists guild channels and accessible active threads directly from Discord,
independently of recent messages. It refreshes guild roles and the bot's own
membership to check `ViewChannel`, including channel permission overwrites. It
never fetches a member roster or message history, and does not require
`ReadMessageHistory` or permission to send messages. Categories are not conversation
channels and are excluded. Private threads must also be joined by the bot or
accessible with `ManageThreads`; inaccessible channels are never returned.

Already-cached direct and group DMs are included without fetching recipients or
opening DMs. Discord does not provide bots with a complete DM directory. Archived
and inaccessible threads are omitted, so `capability.complete` is false even on the
last page. The active-thread response includes the bot's own thread membership
metadata internally; discovery does not request thread member lists or expand
those records into people. `capability.reason` also reports denied guild/thread
requests, stalled guild pagination and scan limits. Unexpected provider errors fail the request
rather than masquerading as an empty directory.

Results contain only `id`, `line`, optional `name`, and `kind`. No avatars, contacts,
members or message bodies are exposed. A listing scans at most 5,001 channel
metadata records, retaining at most 5,000 entries. It budgets 100 metadata requests
and checks a 30-second elapsed limit between discovery operations, returning a
partial reason. A guild refresh and bot membership lookup count as two requests.
An operation already in flight, including SDK retries, can run longer; this budget
does not cancel it. The shared directory deduplicates and sorts canonical lines
and pages one bounded snapshot, so following a cursor does not repeat provider
calls. Partial results stay partial
when the local snapshot is exhausted. Discovery is read-only and uses the existing
connected bot client; it does not create or join a channel.

## Configuration

Each bot is a `discord-bot` account row in the DB with `{ token }` in `accounts.config`
jsonb; optional `owner`. The daemon materializes it to the accounts file the train
reads. See the [root README "Configuration"](../../README.md#configuration).

| Env var | Meaning |
| --- | --- |
| `DISCORD_BOT_ACCOUNTS_FILE` | Optional override for the materialized accounts file path |

## Constraints

- Enable the **Message Content Intent** in the Discord developer portal (Bot tab →
  Privileged Gateway Intents) — without it `messageCreate` events arrive with empty
  content.

No persistent state of its own — safe to restart.
