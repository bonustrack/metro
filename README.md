# @metro-labs/mcp

> Bridge live chat — XMTP, Telegram, Discord, inbound webhooks — into an AI coding session as MCP tools.

Metro lets an AI coding agent (Claude Code) hold real conversations on chat
platforms while it works: inbound messages arrive in the session as events, and the
agent sends, replies, reacts, and manages channels through `mcp__metro__*` tools. It
runs as a single [Bun](https://bun.sh) process that serves the Model Context Protocol
over Streamable HTTP and supervises one subprocess per platform.

## The MCP tools

Every tool takes a `line` — a `metro://<station>/<path>` URI that identifies a
conversation and encodes its platform, so the server routes the call automatically.

| Tool | Purpose |
| --- | --- |
| `send` | Send a message — text and/or `attachments`, optional `reply_to` |
| `create_upload` | Reserve a slot to push a file to metro over HTTP, then attach it with `send` |
| `reply` | Reply to a `message_id` with text |
| `react` / `unreact` | Add / remove an emoji reaction |
| `edit` / `delete` | Edit or delete a message you sent |
| `read` | Read recent history for a conversation |
| `create_channel` / `dm` | Open an XMTP group or 1:1 DM |
| `group_info` / `add_members` / `remove_members` / `set_channel_metadata` / `close_channel` | Manage an XMTP group |
| `ask` | Post a poll (AskUserQuestion-style) on XMTP |
| `list_accounts` | List the configured bot / inbox identities |

Support varies by platform: webhook lines are inbound-only; XMTP has no `edit`/`delete`;
Telegram has no `read`. An unsupported verb returns the platform's reason rather than
failing silently.

## Stations

A **station** is a chat-platform integration:

- **xmtp** — end-to-end-encrypted DMs and groups. Identity is an Ethereum EOA, with
  multi-account support (one raw EOA key per account). Runs on the XMTP
  production network.
- **telegram** — Bot API. One or many bots, each a `telegram` account row in the DB.
- **discord** — bot gateway + REST. One or many bots, each a `discord` account row.
- **webhook** — inbound HTTP receiver (GitHub, Intercom, …). Inbound-only; events
  arrive on `metro://webhook/<account_id>`. Attach one like any other station and Metro
  mints a `POST` url whose token is the whole credential; it runs in-core, with no train.

## Running locally

```sh
bun install
cp .env.example .env     # set DATABASE_URL (accounts live in Postgres — see Configuration)
bun run start            # serves on http://127.0.0.1:8420
```

Accounts load from Postgres at boot. The daemon materializes them into a one-line train
file per active station under `~/.metro/trains/*.ts`, then the supervisor spawns and
hot-reloads one subprocess per file:

```ts
// ~/.metro/trains/xmtp.ts   (generated from the DB — you don't hand-write these)
import '@metro-labs/xmtp/train';
```

## Deploying

[`Dockerfile`](Dockerfile) + [`fly.toml`](fly.toml) + [`.dockerignore`](.dockerignore)
run Metro on [Fly.io](https://fly.io) as **one always-on machine + a single-attach
volume**. The volume attaches to only one machine, which enforces XMTP's
**single-writer** rule for free, and disk-backed deploys replace the machine in place —
so there's never a moment with two writers on the same inbox (which would corrupt MLS
state). The image runs `bun apps/mcp/src/server.ts` directly; the daemon generates a
train per station from the DB at boot and keeps state on the volume.

### 1. Create the app + volume

```sh
fly auth login                       # https://fly.io/docs/flyctl/install/
# edit app = "metro" in fly.toml to a unique name first
fly apps create <your-app-name>
fly volumes create metro_data --app <your-app-name> --region iad --size 10   # GB
```

One volume = one machine. Don't create a second volume/machine — XMTP forbids
concurrent writers.

### 2. Populate the DB + set `DATABASE_URL`

Account config (agents, their API key, station accounts) lives in Postgres — see
[Configuration](#configuration) to provision + populate it. The only secret Metro
needs on Fly is the connection string:

```sh
fly secrets set --app <your-app-name> \
  DATABASE_URL="postgres://user:pass@host:5432/metro"
```

`DATABASE_URL` is the only required var. Station secrets (keys/tokens/
sessions) are DB rows, not Fly secrets. There is no full-access env bearer: every
credential is an `agents.key` row, and `/mcp`, the Monitor transport and attachment
fetching all authenticate with one. `/health` stays public for Fly's health check.

### 3. Deploy

```sh
fly deploy --app <your-app-name>
fly logs --app <your-app-name>     # watch the stations boot
fly status --app <your-app-name>   # should show ONE machine, running
```

### 4. Custom domain + MCP client (optional)

```sh
fly certs add mcp.metro.box --app <your-app-name>
# then add the CNAME / A+AAAA records Fly prints, at your DNS provider

claude mcp add --transport http metro https://mcp.metro.box \
  --header "Authorization: Bearer <the agent's agents.key>"
# or the default host: https://<your-app-name>.fly.dev
```

### Persistence & operating notes

- **Live data** lives on the volume at `/data` (`HOME=/data`): XMTP MLS DBs under
  `/data/.metro/*.db3`, outbox/IPC under `/data/.cache/metro`. It survives restarts,
  deploys, and machine moves. A Fly volume is host-local SSD (durable, daily
  snapshots, 5-day default); for a real safety net add off-box backup (e.g. Litestream
  replicating the SQLite DBs to object storage — restoring rebuilds the *same* DB,
  costing 0 XMTP installation slots).
- **Keep it to one machine.** `fly scale count 1`. Two machines = two XMTP writers =
  corruption. The single-attach volume makes this hard to do by accident.
- **Always-on.** `auto_stop_machines = false` keeps the XMTP streams / Telegram
  long-poll alive. Don't enable autostop.
- **Memory.** Each XMTP account is a live client; bump `[[vm]] memory` in `fly.toml`
  (2gb+) as you add accounts.
- **Dev vs prod.** Use a *separate* XMTP identity for testing (its own key in
  the DB) — redeploys/restarts are safe (the volume persists the MLS DB), but creating
  fresh DBs elsewhere burns the inbox's 10-installation / 256-update budget.

XMTP keeps each inbox's MLS state in a local SQLite database that **must persist**
(losing it re-installs the inbox), and only one instance may run per inbox. Metro is
therefore **single-writer**: one machine, one volume — don't scale past a single
instance, and don't run the same identity in two places.

## Configuration

Account configuration lives in Postgres — it is the single source of truth. The runtime
reads only `DATABASE_URL` (and optional `METRO_AGENT`) plus the non-account server vars
below; no station secret is ever read from the environment. Copy
[`.env.example`](.env.example) → `.env`.

### Database / multi-agent (source of truth)

Metro manages **one or more agents** — each an identity (e.g. "Tony") with its own
station accounts — out of a cloud Postgres database (Drizzle ORM). At boot the daemon
loads agents + accounts from the DB; that is the only way accounts are configured. A
missing `DATABASE_URL` or an empty database is a hard, loud error.

| Var | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required). Agents + accounts load from the DB on boot and are materialized to the per-station account files the trains read. |
| `METRO_AGENT` | Optional. Restrict this instance to one agent by its numeric `id` (the `agents.id` PK). Must be a positive integer that exists, else boot fails loudly. Unset → the daemon runs every agent's accounts in the one process. |

Three small tables. `accounts` references its agent by a plain `agent_id` int
with no foreign key; the one FK in the schema is `agents.owner_id → users.id`
(see [`apps/mcp/src/db/schema.ts`](apps/mcp/src/db/schema.ts)):

- **`users`** — `id` (auto-increment int, primary key; **the owner identity**), `email`
  (the lowercased verified Google email, `UNIQUE`). One row per person. Created on first
  Google sign-in and never again for the same address.
- **`agents`** — `id` (auto-increment int, primary key — **the identity**: every scoping
  decision compares `agents.id`, never the name), `name` (a display label with **no**
  uniqueness of any kind and stored with the casing the person typed, so two agents may
  both be called `Lisa`), `owner_id` (nullable int → `users.id`, `ON DELETE RESTRICT`, so
  a user who still owns an agent cannot be deleted out from under it. `NULL` =
  operator-provisioned, owned by nobody, and not listed by the API to anybody), and
  `key` (nullable text, `UNIQUE`): **the agent's one and only API key**. One key per
  agent, one agent per key. `NULL` means the agent has no key and cannot authenticate
  with one.
- **`accounts`** — `agent_id`, `station` text (`xmtp` | `telegram` | `telegram-user` |
  `discord` today — a plain text column, not a DB enum, so a new station is just a new
  row), `account_id` (the station-local id, e.g. `x0`/`t0`), `allowlist` text[]
  (default `['*']`) — the per-account channel allowlist, and `config` jsonb (the station
  connection secrets + optional `owner` + any extras — see below). Primary key
  (`station`, `account_id`).
`agents.key` is the whole API-key story, and since the env bearer was retired it is the
**only** one. At boot the daemon indexes the keys by SHA-256, and a request presenting
one is authenticated as that agent and **scoped to that agent's accounts only** — on
`/mcp`, on the Monitor transport and on `/attach`. There is no unscoped identity left,
so nothing in the daemon can see every agent at once. Because a key identifies exactly
one agent, the MCP url needs no agent selector beyond the token itself. Because a column
holds one value, a **reset is a hard cutover with no overlap window**: the old key stops
working the instant the new one starts, and every client has to be re-pointed. That is
what `POST /api/agents/<id>/key` does — see *Resetting an agent's key* below.

The `allowlist` column is the sender ids allowed to drive that account's session;
inbound from anyone else is dropped. It defaults to `['*']` (allow all senders); set a
specific array to restrict. It gates the relay only and is stripped from the train files.

Per-station `config` jsonb (connection secrets + optional `owner`):

| station | `config` fields |
| --- | --- |
| `xmtp` | `{ privateKey }` (raw EOA key); optional `owner`, `dbPath` |
| `telegram` | `{ token }`; optional `owner` |
| `telegram-user` | `{ session, apiId, apiHash }`; optional `owner` |
| `discord` | `{ token }`; optional `owner` |
| `whatsapp` | `{ phone }` (E.164 digits) plus the Baileys auth blob under `config.credentials`; optional `owner` |

`account_id` is the station-local id. An operator picks it (`x0`, `t0`, `d0`, `w0`,
`default`); the web UI generates one (`a<agent-id>-<8 hex>`) so two owners can never collide
in the shared (`station`, `account_id`) primary key. Lines are account-scoped
(`metro://telegram/<account>/<chat>`) so replies go back out the same identity. Inbound events are tagged with the owning agent (an `agent` field on the
event), and delivery is scoped to that agent: an account's messages only ever reach a
session authenticated as the agent that owns the account, on the MCP channel and on the
Monitor tail alike. An event that arrives while its agent is disconnected is held, not
dropped, and replays to that agent on its next connect (bounded by the in-memory ring
buffer). One daemon serves several agents at once: each identity gets its own MCP session,
transport, channel stream and event store, so two agents can be connected simultaneously
and neither displaces the other. A second `initialize` from the *same* identity still
supersedes that identity's own previous session. One daemon per agent
(`METRO_AGENT=<id>`, same `DATABASE_URL`) remains the way to keep XMTP's single-writer
rule per inbox, but is no longer needed just to keep two agents live.

**Set up.** Provision Postgres, then from the repo:

```sh
export DATABASE_URL=postgres://user:pass@host:5432/metro
bun --filter @metro-labs/mcp db:migrate    # create the tables
```

Then insert an agent with its API key, take its returned `id`, and insert that agent's
accounts with that `agent_id`; start Metro. `db:generate` regenerates the migration
after a schema change.

```sql
INSERT INTO agents (name, key) VALUES ('tony', 'your-bearer') RETURNING id;   -- e.g. 1
INSERT INTO accounts (agent_id, station, account_id, config)
  VALUES (1, 'telegram', 't0', '{"token":"123:abc"}');   -- allowlist defaults to ['*']
```

> Migration `0006` adds `owner_email`. Migration `0007` drops the unique index it created
> on (`owner_email`, `name`): `agents.id` is the only unique column on that table, and
> `name` is a plain label that may repeat, differ only in case, or be reused by the same
> owner. The drop is `DROP INDEX IF EXISTS`, so re-running it is a no-op.
>
> Migration `0008` replaces `agents.owner_email` with `agents.owner_id`. It creates
> `users`, adds the column and its FK, backfills one `users` row per distinct non-null
> `owner_email` and points every agent at it, then drops `owner_email`. The backfill
> copies the stored email byte for byte, so an agent whose `owner_email` was never
> normalized stays exactly as visible (or invisible) to its owner as it was before. Rows
> with `owner_email IS NULL` keep `owner_id IS NULL`: operator provisioning is untouched.
>
> Names are compared nowhere in any scoping or authorisation path; `agents.id` is. The one
> lookup that was still keyed on a name was the `GOOGLE_EMAIL_AGENTS` grant, and that
> feature is gone: there is no email allowlist and no way to hand one person another
> person's agent. Every check compares ids.
>
> Migration `0009` replaces the `keys` table with `agents.key`. It adds the nullable
> `key` column and its `UNIQUE` constraint, copies each agent's key across, then drops
> `keys`. The copy is a plain column-to-column `UPDATE`, so a key value moves byte for
> byte and every existing `?token=` keeps working. An
> agent with no `keys` row lands on `key IS NULL` (NULLs are distinct under the unique
> constraint, so any number of agents may have none). An agent that somehow had more than
> one key keeps the alphabetically first key *name*, deterministically, and the rest are
> dropped with the table; check for that before running it. If two agents shared one key
> value the unique constraint raises and the whole migration rolls back, leaving `keys`
> intact, which is the intended fail-loud.
>
> **What this gives up: overlapping keys.** With a `keys` table you could add a second key,
> move clients over, then delete the old one. A single column cannot hold two values, so a
> reset overwrites `agents.key` and re-points every client at once, with no overlap window.
> That was a deliberate trade for one key per agent and an unambiguous `?token=`.

### Self-serve agents from the web UI

[`apps/ui`](apps/ui) lets a person sign in with Google and create their own agent
without operator SQL. The daemon exposes one session-gated JSON route for it, mounted
before the MCP auth gate:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/agents` | The signed-in email, the `/mcp` endpoint, the agents that email may see, and those agents' accounts + station capabilities. Every account carries the `agentId` it belongs to, so the panel can show accounts under their agent instead of in one global list. For agents the email **owns**, each key also carries its value, its `?token=` endpoint and the paste-ready `claude mcp add …` command. |
| `POST /api/agents` `{"name":"…"}` | Create an agent owned by the signed-in email, mint its API key, and return the key together with the paste-ready `claude mcp add …` command. |
| `DELETE /api/agents/<id>` | Delete an agent the signed-in email **owns**, and revoke its key. |
| `POST /api/agents/<id>/key` | Reset the key of an agent the signed-in email **owns**: mint a new one, revoke the old one everywhere, and return the new key with its `?token=` endpoint and paste-ready `claude mcp add …` command. |
| `POST /api/agents/<id>/accounts/start` `{"station":"…","token":"…"}` | Attach a station account to an agent the signed-in email **owns**. Validates the credential against the provider first, writes the `accounts` row, and reloads that station. |
| `DELETE /api/agents/<id>/accounts/<station>/<account_id>` | Detach one of that agent's station accounts, forget its credentials, and reload (or stop) the station. |

Sign-in is **open**: any Google account whose `email_verified` claim is true may sign in and
create agents. There is no domain allowlist and no cap on how many agents one email owns.
The id token is still fully verified — RS256 against Google's JWKS, `iss`/`aud`/`exp` and the
login `nonce` all checked, and an unverified email refused.

Auth is the daemon-signed session JWT from the Google login flow, as
`Authorization: Bearer <session>` or `?token=<session>`. **Authorisation is per-agent and
keyed on `agents.id`:** a session may only see agents whose `agents.owner_id` is the
`users` row for its verified email. The email is resolved to a `users.id`
per request, never read from the JWT, so a freshly created agent shows up without
re-login. An email with no `users` row owns nothing: `owner_id IS NULL`
is not a match for "no user", it is the operator-provisioned marker, and those rows are
listed to nobody.

**The key value is served for agents you own, and only those.** `agents.key` is stored in
plaintext (the daemon needs the raw value to mint attachment links as the owning agent),
so the key can be re-served rather than shown once at creation — which is what lets the control panel put the key next to the
endpoint and hand you a ready `claude mcp add …` line. The exposure is gated in two
independent places, and both are load-bearing:

1. `listAgentsForEmail` issues **two disjoint queries** — the list query selects only
   (`id`, `name`, `owner_id`), and the `key` column is re-read for agent ids the session
   owns and nobody else, so a not-owned agent's secret never leaves Postgres.
2. `agent-api.ts` re-checks `agent.owned` when it serialises the key, so a value that
   somehow reached the API layer for a not-owned agent is still replaced with `null`.

The UI masks the value behind a **Reveal** toggle and copies it
without revealing it, so a page load does not leave a live credential on screen.

**Deleting.** `DELETE /api/agents/<id>` addresses the agent by its serial id, never its name,
and only the owner may call it: the row must have `owner_id` equal to the `users` row for
the session email. An agent somebody else owns, or an id that does not exist, is a flat
`404 no such agent`.
An **operator-provisioned row (`owner_id IS NULL`) can never be deleted through this
route** — it is not listed to anybody and answers the same `404`. Deleting removes the agent row
and with it the `key` column holding its credential, and evicts that digest from the in-memory
key map, so the key stops authenticating on `/mcp`, on the Monitor transport and on
`/attach` on the very next request, with no restart. The map is the whole revocation
story; there is no env copy of the value to clear.

**An agent that still has `accounts` rows is refused with `409`**, listing how many;
deletion never cascades into station credentials. Detach the accounts first (from the agent's
page, or with plain SQL), then delete the agent. This also makes "the daemon materialises a
station for a deleted agent" impossible by construction: an agent can only be deleted when it
owns zero accounts.

**Resetting an agent's key.** `POST /api/agents/<id>/key` mints a new key for an agent the
signed-in email **owns** and revokes the old one, in one step. Authorisation is the same
`ownedAgentOrThrow` predicate delete and attach use, so it cannot drift from them: somebody
else's agent, an unknown id or an operator-provisioned row is a flat `404 no such agent`.
It is a session route like the rest — an agent key cannot
reset itself. The response is `200 {id, name, reset: true, key, endpoint, command}`, the same
credential shape `POST /api/agents` returns.

There is **no overlap window, by design**:

- One `UPDATE agents SET key = … WHERE id = … AND owner_id = …` re-asserts ownership in the
  statement itself, and a `23505` unique violation is retried with a fresh key, so the
  `agents_key_unique` constraint cannot be tripped.
- The in-memory key map is then swapped in a single synchronous `rotateAgentKey` call — evict
  the old digest, insert the new one — so there is never a moment with two live keys for one
  agent, nor one with none. The row commits, then the map swaps, then the new key goes out in
  the response.
- The old key stops authenticating on `/mcp`, on the Monitor transport and on `/attach` on the
  very next request, with no restart.
- **The live MCP session for that agent is closed and its SSE stream is ended at the wire.** A
  stream authenticates once, when it attaches, so a client holding the old key would otherwise
  keep receiving that agent's traffic indefinitely. The client reconnects with the new key and
  picks up where it left off: the per-identity replay ledger survives the session, so a message
  that arrives during the gap is delivered on reconnect.
- **Attachment links are not affected.** Each link carries its own per-attachment token, not the
  agent's key (see *Attachments* below). The one exception is transitional: links minted before
  that change embedded the key verbatim, and the first reset kills all of them — which is
  exactly how you retire a key that has leaked into chat history or an archive.
- Nothing else changes: station accounts, the agent's id and name, and every other agent's key
  are untouched.

| Var | Default | Meaning |
| --- | --- | --- |
| `METRO_SESSION_SECRET` | — | Required for `/api/agents` and Google login. Unset → 401. |

### Inbound webhooks

A webhook endpoint is an `accounts` row like any other station account, so it belongs to
one agent and its events reach only that agent. Attach one from the agent's page (or
`POST /api/agents/<id>/accounts/start` with `{"station":"webhook"}`); the `201` carries the
url and the signing secret, and the secret is shown that one time only.

```sh
curl -X POST "https://mcp.metro.box/api/webhooks/<webhook_id>/<token>" \
  -H "content-type: application/json" -d '{"hello":"world"}'
```

The whole URL is the credential — there is no signature header and nothing else to
configure, so any provider that takes a webhook URL works by pasting it in. Treat it like a
password: anyone holding it can post events to that agent.

The `<webhook_id>` is its own random 19-digit id, not the account id — an account id encodes
the agent it belongs to, and this URL gets pasted into other people's systems.

Anything that is not an exact token match is a `404`, compared in constant time. `GET` on
the same url answers a readiness line and emits nothing, so it is safe as a health check.
Events arrive on `metro://webhook/<account_id>` and are inbound-only — an agent cannot
`send`, `reply` or `react` on that line.

The agent is handed a `[webhook received]` note with the pretty-printed body, capped at
8 KiB, plus an allowlist of headers — a delivery's `authorization`, `cookie` and
`x-hub-signature-256` never reach the agent.

Detaching the account (`DELETE /api/agents/<id>/accounts/webhook/<account_id>`) takes the
url out of service at the next materialize.

### Attaching station accounts from the web UI

Creating an agent does **not** create station accounts; a new agent starts empty. From the
agent's page you can attach one yourself; `POST /api/agents/<id>/accounts/start` is the only
route that writes the `accounts` table, and it writes nothing else.

| station | what you supply | what Metro checks before storing anything |
| --- | --- | --- |
| `discord` | the bot token | `GET /users/@me` with `Authorization: Bot <token>`. A rejected token is a `400` at attach time, not a dead train at the next boot. `GET /applications/@me` is read too: the Discord train always requests the **Message Content** intent, so an application that does not have it enabled is refused with the fix spelled out, rather than crash-looping on `Used disallowed intents`. If that second call cannot be read, the attach is allowed through. |
| `telegram` | the bot token | `getMe`, which must answer `ok:true` for an `is_bot` identity. |
| `xmtp` | nothing | Metro generates the 32-byte secp256k1 key itself, then **opens an XMTP inbox with it** before the row is written. The check runs in a short-lived subprocess (`@metro-labs/xmtp/verify`, key over stdin) against the same `~/.metro/xmtp-production-<hex>.db3` the train will use, and that path is stored in `config.dbPath`, so the train reuses the installation that was just verified instead of burning a second one out of the inbox's ten. `inboxId` and `address` come back on the `201`. If XMTP cannot be reached, or answers with an unregistered client, the attach is a `400` and the half-built database is deleted. |
| `telegram-user` | api id + api hash from my.telegram.org, then the phone number | The whole MTProto sign-in: Telegram sends a login code to that number, and asks for the two-step verification password if the account has one. |
| `whatsapp` | a phone number, or nothing to scan a QR instead | The whole multi-device pairing: Metro opens a Baileys socket, shows the QR or the 8-character pairing code, and waits for the handset. |
| `webhook` | nothing | Nothing to check — there is no provider. Metro generates the account id, mints a random webhook id and a token, and answers with the endpoint url built from those two. The url never contains the account id. The url is live as soon as the row is written; no train is spawned, and the url stays retrievable from the station's page. |

The last two cannot finish in one request, so they run as a short-lived **attach session**:

| method | path | |
| --- | --- | --- |
| `POST` | `/api/agents/<id>/accounts/start` | answers `201 { status: "pending", attachId, step, prompt, qr, pairingCode, expiresAt }` instead of `status: "done"` |
| `GET` | `/api/agents/<id>/accounts/<attach_id>` | poll: the QR rotates, the step moves `code` to `password`, and the status becomes `done` or `failed` |
| `POST` | `/api/agents/<id>/accounts/<attach_id>/step` | `{"code":"…"}` or `{"password":"…"}` |
| `DELETE` | `/api/agents/<id>/accounts/<attach_id>` | abandon it now rather than waiting for the timeout |

`<attach_id>` is `as_` + 22 random base64url characters, which is disjoint from every station
name, so the router can tell an attach session from an account path without guessing.

The session state is **in memory only and never persisted**. It holds a live provider client,
which is the thing that holds the credential in flight; the credential itself is handed
straight to the `accounts` row on success and is never stored on the session or returned in a
poll. A session lives five minutes, one agent may have two at a time and the daemon forty, a
sweeper runs every fifteen seconds, and expiring, cancelling or shutting the daemon down all
tear the provider client down. Nothing is written to `accounts` until the sign-in actually
completes, so an abandoned attempt leaves no trace.

Rules that hold for every station:

- **No row exists unless the credential was demonstrated to work.** Every station checks
  against the real provider *before* `attachAccount` is called, and a refusal is a `400`/`409`
  that leaves the `accounts` table byte for byte as it was: no row, no train stub, no station
  reload. If the write itself fails after a good check, whatever the check created on disk is
  discarded (`PreparedAccount.discard`). "Well-formed" is never enough on its own: a generated
  XMTP key is well-formed by construction, which is exactly why it is registered before it is
  stored.
- **Authorisation is the same predicate as delete.** `ownedAgentOrThrow` is one function used
  by both: the agent must have `owner_email` equal to the session email. Somebody else's agent
  or an unknown id is a flat `404`, and so is an operator-provisioned row.
- **`account_id` is generated by the server** (`a<agent-id>-<8 hex>`), never taken from the
  request. Two people therefore cannot collide in the shared (`station`, `account_id`) primary
  key, and nobody can probe which ids already exist.
- **The credential is never returned again.** `GET /api/agents` re-serves `agents.key` for agents
  you own; station credentials are deliberately **not** part of that exposure. The `accounts`
  payload is what the trains report (id, username, address, …) and has never carried secrets.
- **A duplicate bot token is `409`.** Two `telegram` accounts sharing a token make the whole
  telegram train refuse to boot, so the collision is caught at attach.
- **The station reloads immediately.** After the row lands, the daemon re-materialises the
  account files from Postgres and asks the supervisor to reload just that station's train:
  restarting it if it was already running, spawning it if this is the station's first account,
  stopping it when the last account is detached. Train stubs are only rewritten when their
  content actually changes, so attaching a Telegram account does not restart XMTP. The response
  carries `activated: false` if that reload failed; the row is still valid and comes up at the
  next boot.

**Is the generated XMTP key recoverable?** Not through Metro. It is stored in
`accounts.config.privateKey` in plaintext, like every other station secret, so an operator with
database access can read it, but **no API ever returns it again**, so the one-time panel shown
at creation is the only copy the person attaching it will get. Copy it out then, or treat the
identity as disposable and attach a new one.

> `telegram-user` and `whatsapp` sign in as **real user accounts**, not bots. The stored
> session and the stored Baileys blob are full-account credentials, both carry a ban risk under
> the platforms' terms, and both are single-writer per account. Use a number you are willing to
> dedicate to the agent. `packages/whatsapp/scripts/login.ts` and
> `packages/telegram-user/scripts/login.ts` still work as the operator equivalents.

On a `METRO_AGENT`-pinned daemon the generated key is **not** accepted by that daemon (it
only serves the pinned agent's key, before and after a restart alike). The key is still
valid in the database and starts working as soon as a daemon that serves the new agent
runs.

Restrict who can drive an account via the `allowlist` column (default `['*']` = allow all):

```sql
UPDATE accounts SET allowlist = ARRAY['<sender-id>'] WHERE station='xmtp' AND account_id='tony';
```

### Server

| Var | Default | Meaning |
| --- | --- | --- |
| `METRO_PUBLIC_URL` | tunnel hostname | Base URL for attachment links. Unset → falls back to the tunnel hostname; with neither, attachments are surfaced by local path only. |
| `METRO_HTTP_HOST` | `127.0.0.1` | HTTP bind host; set `0.0.0.0` behind a platform proxy |
| `METRO_WEBHOOK_PORT` | `8420` | HTTP port |
| `METRO_LOG_LEVEL` | `info` | `trace`–`fatal`; logs go to stderr |

## Connecting a client

The HTTP server serves the **MCP at the root path** (so it can sit behind its own host,
e.g. `https://mcp.metro.box`), plus `GET /health` and the webhook receiver at
`/api/webhooks/<id>/<token>`. Register it:

```sh
claude mcp add --transport http metro https://mcp.metro.box \
  --header "Authorization: Bearer <the agent's agents.key>"
```

Metro is a Claude Code **channel** — it pushes inbound chat into a running session.
Start Claude Code with the channel flag:

```sh
claude --dangerously-load-development-channels server:metro
```

Inbound messages then arrive as `<channel source="metro" line="…" …>text</channel>`
events; the agent replies with the tools above, and tool-approval prompts relay to the
chat so you can answer from your phone. (Requires Claude Code v2.1.80+ and claude.ai or
Console API auth.)

Inbound is only noticed between tool calls, so a session busy with a build or a grep
answers late. [Orchestrator-only main thread](docs/SETUP.md#orchestrator-only-main-thread)
is the optional configuration that fixes that: a `PreToolUse` hook leaves the main
thread able to delegate and to talk on Metro, and moves all other work to subagents.

If you turn Claude Code's telemetry off, read
[Privacy and data retention](docs/SETUP.md#privacy-and-data-retention) first. Disabling
telemetry also disables feature-flag evaluation, which disables channels, which stops
inbound delivery silently on the next reconnect — `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1`
is the fix. That section also covers the local plaintext transcripts, which no
server-side retention setting touches.

### Monitor transport

The **Channel** above is the primary transport. The **Monitor** is an optional
second, lightweight live transport served on the same HTTP port for tools that
want to observe and drive Metro over plain HTTP (no MCP client needed). It is
**live-only by design** — no history, backlog, or replay — and can be attached
mid-session.

The Monitor uses the same credential as `/mcp`: an `agents.key` (or a Google
session JWT), as `?token=<key>` or `Authorization: Bearer`. It is **scoped like
`/mcp`**: the tail carries only events on the caller's own station accounts, and
a call may only drive a line that belongs to one of them. While the daemon holds
no credential at all — no `agents.key` and no `METRO_SESSION_SECRET` — the
`/api/*` surface stays disabled (returns 404), so there is no unauthenticated
surface.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/tail` | Server-Sent Events stream of live bus events from the moment of connection (25s keepalive). No replay. |
| `POST /api/call/:train/:action` | Invoke a station verb (`send`/`reply`/`react`/…) over HTTP; routes through the station registry and returns the dispatch result as JSON. |
| `GET /api/health` | `{ ok, service, version, uptime_s }` snapshot. |

Auth is `Authorization: Bearer <the agent's agents.key>` (or `?token=`):

```sh
curl -N -H "Authorization: Bearer $METRO_AGENT_KEY" http://127.0.0.1:8420/api/tail
curl -X POST -H "Authorization: Bearer $METRO_AGENT_KEY" \
  -H 'content-type: application/json' \
  -d '{"args":{"line":"metro://discord/<account_id>/<channel_id>","text":"hi"}}' \
  http://127.0.0.1:8420/api/call/discord/send
```

The line is what carries the scope, so it is required: a scoped caller may only
drive an account it owns, and an `account` argument may not re-route the call to
somebody else's. A call with no line at all (`accounts`, for instance) is served
only when every account of that station belongs to the caller, which is how a
whole-station query stops working the moment a second agent joins that station.
`GET /api/health` stays in front of the auth gate and returns the same
`version`/`uptime` snapshot as the public `/health`.

### Attachment links

Inbound media is cached under `$HOME/.cache/metro/messenger-uploads` and surfaced
on the event as an absolute `/attach/<name>` url on `METRO_PUBLIC_URL`. The
`?token=` in that url is a **per-attachment token** — 32 CSPRNG bytes, good for
that one file and nothing else. It is **not** the agent's key: a delivered link
travels through chat history, logs and archives, and it must not be a copy of a
credential that opens `/mcp`.

When the daemon mints the url it writes two 0600 sidecars next to the cached
file: `.owner` (the agent id) and `.grant` (the token, bound to that same agent
id). `/attach` serves the file on either of two paths, and both re-check the
owner: the caller presents that attachment's own token, or the caller
authenticates as an identity scoped to the owning agent. Anything else — another
attachment's token, another agent's key, an unknown or missing token, an
attachment with no recorded owner — is a flat `401`, never a serve. The
capability path fails closed: no `.grant` file means no token can match it.

Because the link's authority is its own token, **resetting an agent's key does
not break links already handed out**. Links minted before this change did carry
the key, and a reset kills those.

### Sending a file out

An attachment on `send` names exactly one source, and only one of them is right
for the normal case — a file sitting on the machine the agent runs on:

| Source | Use it when | Why not otherwise |
| --- | --- | --- |
| `upload` | **almost always**, up to 64 MiB | — |
| `data` | the file is a few KB at most | the base64 has to be written out verbatim inside the tool call, and a model cannot emit tens of thousands of characters of it without corrupting them. Measured practical ceiling: roughly 10 KB, far below the 8 MiB the daemon would accept |
| `url` | the file is already published | the daemon fetches it, so it has to be publicly reachable — which rules it out for anything confidential |
| `path` | the file is already on the daemon host | it is resolved on the **daemon's** filesystem, not the caller's. A local-looking absolute path is refused |

The `upload` route moves the bytes over HTTP, straight from the caller's disk to
the daemon, so they never pass through the model's context and nothing is
published:

```bash
# 1. MCP, no shell needed: mint a slot
#    create_upload({name: "q3-results.pdf"})
#    -> { upload_id: "up_…", upload_url: "https://mcp.metro.box/api/uploads/up_…?token=ut_…", curl: "…" }

# 2. the one step that needs a shell — push the bytes
curl -sS -T q3-results.pdf "https://mcp.metro.box/api/uploads/up_…?token=ut_…"

# 3. MCP again: attach it
#    send({line, text: "the numbers", attachments: [{upload: "up_…"}]})
```

Step 2 needs a shell and there is no way around that: anything carried in an MCP
call is model output by construction, so an MCP-only path puts the bytes back
through the model, which is the problem `data` already has. An agent that cannot
run commands should delegate that single line to one that can and keep the
`upload_id` — the slot belongs to the metro **agent**, not to whoever ran the
command.

If you have the agent's key to hand you can skip `create_upload` entirely and
post the file in one request, authenticated exactly like `/api/tail` and
`/attach`:

```bash
curl -sS -H "Authorization: Bearer $METRO_AGENT_KEY" \
     --data-binary @q3-results.pdf \
     "https://mcp.metro.box/api/uploads?name=q3-results.pdf"
```

An upload is **owned by the uploading agent and scoped exactly like an
attachment**: the same `.owner` / `.grant` sidecars, the same two-path check, and
`send` re-checks the owner before it resolves the id. Another agent naming the id
gets the same answer as an agent naming an id that never existed.

Uploads are **transient**. They live in the daemon's temp directory, never in the
durable attachment cache that `/attach` serves, they expire **30 minutes** after
they are created, and a reaper sweeps every 60 seconds. `DELETE
/api/uploads/<id>` drops one early. A successful `send` does *not* consume the
upload, so a retry after a timed-out call still works.

Limits: **64 MiB per file** and 512 MiB of pending uploads daemon-wide. Over
either, the request is refused with an error that names the limit — it is never
truncated. Stations impose their own, lower ceilings on top of that (XMTP refuses
non-image files over ~190 KiB), and those still fire first.

## How it works

One process does everything:

- a **supervisor** spawns and multiplexes the station subprocesses,
- the **MCP** is served in the same process — the dispatcher publishes inbound
  events to an in-process event bus, the MCP's inbound relay subscribes and pushes
  `notifications/claude/channel`, and outbound dispatches straight to the stations.

Inbound is never journaled to disk: the dispatcher publishes each event to an
in-memory event bus ([`src/daemon/events.ts`](apps/mcp/src/daemon/events.ts)) and the
MCP relay subscribes to push channel notifications. The MCP HTTP transport is also
session-tolerant: it survives a daemon restart so connected sessions auto-resume.

**Lines.** Every conversation is a `metro://<station>/<path>` URI — the station is the
host, the path is platform-specific (account-scoped for multi-bot). One parser
([`src/stations/lines.ts`](apps/mcp/src/stations/lines.ts)) owns the scheme.

**Envelope.** Inbound and outbound events share one shape (`{kind?, id?, ts?, station?,
line, from?, to?, message_id?, text?, payload?, …}`, see
[`src/daemon/protocol.ts`](apps/mcp/src/daemon/protocol.ts)).

**State.** Metro is stateful and needs a persistent volume: the XMTP MLS databases under
`~/.metro/` and the IPC socket under `$METRO_STATE_DIR`
(default `~/.cache/metro`).

## Development

```sh
bun run build      # tsc -> dist/
bun run typecheck
bun run test
bun run lint
```

## Project structure

A bun-workspaces + turborepo monorepo: the core daemon lives in `apps/mcp`, and
each external messaging platform is a private station package under `packages/`.

```
apps/
  mcp/                  # @metro-labs/mcp — the core daemon (see apps/mcp/README.md)
    src/
      server.ts         # entry (bin: metro-daemon) — imports daemon/boot
      daemon/           # the supervised runtime: supervisor + dispatcher HTTP
                        #   (/health, /mcp, /api/webhooks/…) + IPC + bus + paths/tunnel
      mcp/              # the MCP protocol surface (createMetroMcp) at the root path
      stations/         # the station contract + runtime + registry the core reads:
                        #   types.ts            — Station/StationTool/Verb contract
                        #   station-runtime.ts  — makeStation, CallMsg, emit/respond
                        #   account-store.ts    — multi-bot account store (csv, genIds)
                        #   attachments.ts      — saveBufferToCache, toCanonical, MIME
                        #   registry.ts         — the static list of station descriptors
                        #   lines.ts            — the metro:// Line parser

packages/               # private station packages — each implements the contract
  xmtp/                 #   imported from @metro-labs/mcp/stations/*
  telegram/             #   (see each package's README.md)
  discord/
  webhook/
```

The station contract and runtime live in the core (`apps/mcp/src/stations`) and are
re-exported via `@metro-labs/mcp/stations/*`; the platform packages depend only on
`@metro-labs/mcp` and stay isolated (e.g. the XMTP node SDK never enters the core graph).
See the per-package READMEs: [apps/mcp](apps/mcp/README.md),
[xmtp](packages/xmtp/README.md), [telegram](packages/telegram/README.md),
[discord](packages/discord/README.md), [webhook](packages/webhook/README.md).

## License

MIT
