# @metro-labs/mcp

> Bridge live chat — XMTP, Telegram, Discord, WhatsApp, inbound webhooks — into an AI
> coding session as MCP tools.

Metro lets an AI coding agent (Claude Code) hold real conversations on chat platforms
while it works: inbound messages arrive in the session as events, and the agent sends,
replies, reacts, and manages channels through `mcp__metro__*` tools. It runs as a single
[Bun](https://bun.sh) process that serves the Model Context Protocol over Streamable HTTP
and supervises one subprocess per platform.

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
Telegram and WhatsApp have no `read`. An unsupported verb returns the platform's reason
rather than failing silently.

## Stations

A **station** is a chat-platform integration. Each is a `stations` row in Postgres, and
each runs as its own supervised subprocess except webhook, which runs in-core.

- **xmtp** — end-to-end-encrypted DMs and groups. Identity is an Ethereum EOA (one raw
  key per account), on the XMTP production network.
- **telegram-bot** — Bot API. One or many bots.
- **telegram** — a real Telegram **user account** over MTProto, not a bot.
- **discord-bot** — bot gateway + REST.
- **whatsapp** — a real WhatsApp **user account** over the multi-device Web protocol.
- **webhook** — inbound HTTP receiver (GitHub, Intercom, …). Inbound-only; events arrive
  on `metro://webhook/<account_id>`. Metro mints a `POST` url whose token is the whole
  credential.

> `telegram` and `whatsapp` sign in as real user accounts. The stored session and
> Baileys blob are full-account credentials, both carry a ban risk under the platforms'
> terms, and both are single-writer per account. Use an identity you are willing to
> dedicate to the agent.

## Running locally

```sh
bun install
cp .env.example .env     # set DATABASE_URL (accounts live in Postgres — see Configuration)
bun run start            # serves on http://127.0.0.1:8420
```

Accounts load from Postgres at boot. The daemon materializes them into a one-line train
file per active station under `apps/mcp/trains/*.ts` (`METRO_TRAINS_DIR` overrides), then the supervisor spawns and
hot-reloads one subprocess per file:

```ts
// apps/mcp/trains/xmtp.ts   (generated from the DB — you don't hand-write these)
import '@metro-labs/xmtp/train';
```

## Deploying

### 1. Create the app + volume

```sh
# edit app = "metro" in fly.toml to a unique name first
fly apps create <your-app-name>
fly volumes create metro_data --size 3 --region iad
```

### 2. Populate the DB + set `DATABASE_URL`

```sh
export DATABASE_URL=postgres://user:pass@host:5432/metro
bun --filter @metro-labs/mcp db:migrate
fly secrets set DATABASE_URL="$DATABASE_URL"
```

### 3. Deploy

```sh
fly deploy
```

### 4. Custom domain + MCP client (optional)

```sh
fly certs add mcp.example.com
# then add the CNAME / A+AAAA records Fly prints, at your DNS provider
```

### Persistence & operating notes

- **Live data** lives on the volume at `/data` (`HOME=/data`): XMTP MLS DBs under
  `/data/.metro/*.db3`, IPC under `/data/.cache/metro`. It survives restarts, deploys and
  machine moves. A Fly volume is host-local SSD; for a real safety net add off-box backup
  (e.g. Litestream replicating the SQLite DBs — restoring rebuilds the *same* DB, costing
  0 XMTP installation slots).
- **Keep it to one machine.** `fly scale count 1`. Two machines = two XMTP writers =
  corruption. The single-attach volume makes this hard to do by accident.
- **Always-on.** `auto_stop_machines = false` keeps the XMTP streams and Telegram
  long-poll alive.
- **Memory.** Each XMTP account is a live client; bump `[[vm]] memory` (2gb+) as you add
  accounts.
- **Dev vs prod.** Use a *separate* XMTP identity for testing. Redeploys are safe (the
  volume persists the MLS DB), but creating fresh DBs elsewhere burns the inbox's
  10-installation / 256-update budget.
- **Every deploy is a brief outage** (40–90s observed) and it drops the SSE stream of
  every connected MCP client permanently — the client keeps working for tool calls but
  receives no inbound chat. Reconnect metro in each session after deploying.

XMTP keeps each inbox's MLS state in a local SQLite database that **must persist**
(losing it re-installs the inbox), and only one instance may run per inbox. Metro is
therefore **single-writer**: one machine, one volume.

## Configuration

Account configuration lives in Postgres — the single source of truth. The runtime reads
only `DATABASE_URL` (and optional `METRO_AGENT`) plus the server vars below; no station
secret is ever read from the environment. Copy [`.env.example`](.env.example) → `.env`.

### Database / multi-agent (source of truth)

Metro manages **one or more agents** — each an identity (e.g. "Tony") with its own
station accounts. At boot the daemon loads agents + accounts from the DB; that is the only
way accounts are configured. A missing `DATABASE_URL` or an empty database is a hard,
loud error.

| Var | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required). |
| `METRO_AGENT` | Optional. Restrict this instance to one agent by its `agents.id` (11 characters, e.g. `l0q57dPlRc-`). Must exist, else boot fails loudly. Unset → the daemon runs every agent's accounts in one process. |

Four small tables ([`schema.ts`](apps/mcp/src/db/schema.ts)). **Every `id` is an
11-character URL-safe random string** (`A-Za-z0-9_-`, like a YouTube video id, e.g.
`l0q57dPlRc-`) and is the first column of its table. Both foreign keys point at
`users.id` (`agents.owner_id` and `connectors.user_id`, each `ON DELETE RESTRICT`);
`stations` references its agent by a plain text column with none.

- **`users`** — `id`, `address` (the lowercased wallet address, `UNIQUE`), `email` (nullable,
  only on rows from before wallet sign-in). One row per person, created on first sign-in.
- **`agents`** — `id` (**the identity**: every scoping decision compares `agents.id`,
  never the name), `name` (a display label with no uniqueness of any kind, stored with the
  casing typed, so two agents may both be `Lisa`), `owner_id` (nullable → `users.id`,
  `ON DELETE RESTRICT`; `NULL` = operator-provisioned, owned by nobody and listed to
  nobody), `key` (nullable text `UNIQUE`) — **the agent's one and only API key**.
- **`stations`** (renamed from `accounts` in `0011`) — `id`, `agent_id`, `station` text
  (`xmtp` | `telegram-bot` | `telegram` | `discord-bot` | `whatsapp` | `webhook` — a plain
  text column, not a DB enum, so a new station needs no migration), `account_id`,
  `allowlist` text[] (default `['*']`), and `config` jsonb, with
  `UNIQUE (station, account_id)`. `account_id` is the station's public handle — it appears
  in `metro://` lines and in the WhatsApp token filename — and `0011` left those values
  alone.
- **`connectors`** — `id`, `user_id` (→ `users.id`), `name`, `url`, `transport` text
  (`http`), `config` jsonb (`{auth, createdAt, verified}`), `UNIQUE (user_id, name)`.
  Verified bookmarks for **remote** MCP servers, owned by the person rather than by an
  agent; nothing in the relay, the bus or the trains reads this table. See
  [Connectors](#connectors).

`agents.key` is the whole API-key story. At boot the daemon indexes the keys by SHA-256,
and a request presenting one is authenticated as that agent and **scoped to that agent's
accounts only** — on `/mcp`, on the Monitor transport and on `/attach`. There is no
unscoped identity left, so nothing in the daemon can see every agent at once. Because a
key identifies exactly one agent, the MCP url needs no agent selector beyond the token.

The `allowlist` column is the sender ids allowed to drive that account's session; inbound
from anyone else is dropped. It gates the relay only and is stripped from the train files.

Per-station `config` jsonb (connection secrets + optional `owner`):

| station | `config` fields |
| --- | --- |
| `xmtp` | `{ privateKey }` (raw EOA key); optional `dbPath` |
| `telegram-bot` | `{ token }` |
| `telegram` | `{ session, apiId, apiHash }` |
| `discord-bot` | `{ token }` |
| `whatsapp` | `{ phone }` (E.164 digits) plus the Baileys auth blob under `credentials` |
| `webhook` | `{ secret, webhookId }` |

`account_id` is the station-local id. An operator picks it (`x0`, `t0`, `w0`); the web UI
generates one (`a<agent-id>-<8 hex>`) so two owners can never collide in the shared
primary key. Lines are account-scoped (`metro://telegram-bot/<account>/<chat>`) so replies go
back out the same identity.

Inbound events are tagged with the owning agent and **delivery is scoped to it**: an
account's messages only ever reach a session authenticated as the agent that owns the
account, on the MCP channel and the Monitor tail alike. An event arriving while its agent
is disconnected is held, not dropped, and replays on the next connect (bounded by the
in-memory ring buffer). One daemon serves several agents at once — each identity gets its
own MCP session, transport, channel stream and event store, so two agents can be connected
simultaneously and neither displaces the other.

**Set up.** Provision Postgres, then from the repo:

```sh
export DATABASE_URL=postgres://user:pass@host:5432/metro
bun --filter @metro-labs/mcp db:migrate    # create the tables
```

Then insert an agent, take its returned `id`, and insert that agent's accounts:

```sql
INSERT INTO agents (name, key) VALUES ('tony', 'your-bearer') RETURNING id;   -- e.g. 1
INSERT INTO accounts (agent_id, station, account_id, config)
  VALUES (1, 'telegram-bot', 't0', '{"token":"123:abc"}');   -- allowlist defaults to ['*']
```

`db:generate` regenerates the migration after a schema change. Applied migrations are in
[`apps/mcp/drizzle/`](apps/mcp/drizzle/); the ones worth knowing about are `0007` (drops
name uniqueness — `agents.id` is the only unique column), `0008` (replaces `owner_email`
with `owner_id` and creates `users`), `0009` (replaces the `keys` table with `agents.key`)
and `0010` (adds `connectors`). `0009` gives up overlapping keys deliberately: a single
column cannot hold two values, so a reset re-points every client at once with no overlap
window.

**Migrations apply themselves on deploy.** `fly.toml` sets a `release_command`, so Fly runs
`bun --filter @metro-labs/mcp db:migrate` in a temporary machine with the app's secrets
before the new version goes live. If it fails the deploy is **aborted** and the old machine
keeps serving — a bad migration can never crash-loop the daemon, which is why this runs on
release rather than at boot. `drizzle-kit` is therefore a runtime dependency, not a
devDependency, so it is present in the production image.

It is the same command by hand, against any database you can reach:

```bash
DATABASE_URL='postgres://…' bun --filter @metro-labs/mcp db:migrate
```

### Self-serve agents from the web UI

[`apps/ui`](apps/ui) lets a person sign in with an Ethereum wallet and create their own agent without
operator SQL. The daemon exposes session-gated JSON routes for it, mounted before the MCP
auth gate:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/agents?project=<id>` | The signed-in email, the `/mcp` endpoint, that project's agents (each with its `connector_ids`, its runtime label and liveness), and with `&accounts=1` their accounts + station capabilities. Every account carries the `agentId` it belongs to. For agents the email **owns**, each carries its key value, its `?token=` endpoint and the paste-ready `claude mcp add …` command. |
| `POST /api/agents` `{"name":"…"}` | Create an agent, mint its key, return both with the paste-ready command. |
| `DELETE /api/agents/<id>` | Delete an agent you **own**, and revoke its key. |
| `POST /api/agents/<id>/key` | Reset the key of an agent you **own**. |
| `POST /api/agents/<id>/accounts/start` | Attach a station account. Validates the credential against the provider first, writes the row, reloads that station. |
| `DELETE /api/agents/<id>/accounts/<station>/<account_id>` | Detach an account, forget its credentials, reload (or stop) the station. |
| `GET /api/connectors` | Your [connectors](#connectors). Carries **no credential**; the paste-ready `mcpServers` block comes from `GET /api/cli/mcp` with an agent token (see [The metro CLI](#the-metro-cli)). |
| `POST /api/connectors` `{"name","url","header","value"}` | Verify a remote MCP server and store it. `header`/`value` are optional and go together. |
| `POST /api/connectors/<id>/verify` | Re-check a stored connector. `200 {ok:true, verified}` or `200 {ok:false, reason}`. |
| `POST /api/connectors/<id>/rename` `{"name"}` | Rename a connector you own. `409` only if the new name collides on an agent that holds it. |
| `GET`/`POST /api/projects` | Your [projects](#projects), and create one. `POST /<id>/rename`, `DELETE /<id>`, and `/<id>/members` for the roster. |
| `GET`/`POST /api/agents/<id>/connectors` `{"connectorId"}` | The [connectors an agent holds](#agents-hold-connectors), and add one. `DELETE /<id>/connectors/<connectorId>` removes it. |
| `POST /api/agents/<id>/code` | Mint the single-use pairing code that `metro login` and `metro start` both take. |
| `DELETE /api/connectors/<id>` | Delete a connector you own. |

Sign-in is **open** and is [Sign-In with Ethereum](https://eips.ethereum.org/EIPS/eip-4361):
any wallet may sign in and create agents, with no allowlist and no cap. The page fetches a
single-use nonce from `GET /auth/siwe/nonce`, the wallet signs the message, and
`POST /auth/siwe/verify` checks the signature, the site the message names, the nonce and the
expiry before it answers with the session. The login page offers every wallet extension
the browser announces (MetaMask, Rabby, …), **WalletConnect** for the wallet app on your phone
(a Reown project id is built in; `VITE_WC_PROJECT_ID` overrides it at build time) and **Coinbase Wallet**; the two SDKs load only when their button is pressed.
Externally owned accounts only for now; a smart-contract wallet is refused with a message
saying so. Your wallet is your account: lose it and another admin of your projects has to
invite the new address.

Auth is the daemon-signed session JWT, as `Authorization: Bearer` or `?token=`.
**Authorisation is per-agent and keyed on `agents.id`:** a session may only see agents
of a [project](#projects) its address is a member of. The address resolves to a
`users.id` per request, never read from the JWT, so a freshly created agent shows up
without re-login. An address with no `users` row is a member of nothing.

**The key value is served for agents you own, and only those.** `agents.key` is stored in
plaintext so it can be re-served rather than shown once, which is what lets the panel put
the key next to the endpoint and hand you a ready `claude mcp add` line. The exposure is
gated in two independent places, both load-bearing: `listAgentsForUser` issues two
disjoint queries (the list selects only id/name/owner_id, and `key` is re-read for owned
ids only, so a not-owned agent's secret never leaves Postgres), and `agent-api.ts`
re-checks `agent.owned` when it serialises. The UI masks the value behind a **Reveal**
toggle and copies it without revealing it.

**Deleting** addresses the agent by serial id, never its name, and only the owner may call
it. Somebody else's agent, an unknown id, or an operator-provisioned row is a flat `404`.
Deleting removes the row and its key and evicts the digest from the in-memory key map, so
the key stops authenticating on the very next request with no restart — the map is the
whole revocation story. **An agent that still has `stations` rows is refused `409`**;
deletion never cascades into station credentials, which also makes "the daemon
materialises a station for a deleted agent" impossible by construction.

**Resetting a key** mints a new one and revokes the old one in one step, through the same
`ownedAgentOrThrow` predicate delete and attach use. There is **no overlap window, by
design**: one `UPDATE … WHERE id = … AND owner_id = …` re-asserts ownership in the
statement itself, then the key map is swapped in a single synchronous call, so there is
never a moment with two live keys or none. The row commits, the map swaps, then the new
key goes out. **The live MCP session for that agent is closed and its SSE stream ended at
the wire** — a stream authenticates once, when it attaches, so a client holding the old key
would otherwise keep receiving that agent's traffic indefinitely. The client reconnects
with the new key and picks up where it left off. **Attachment links are unaffected**, since
each carries its own per-attachment token.

| Var | Default | Meaning |
| --- | --- | --- |
| `METRO_SESSION_SECRET` | — | Required for `/api/agents`, `/api/connectors` and wallet sign-in. Unset → 401. |

### Connectors

A connector is a **verified bookmark for someone else's MCP server** — Linear, Sentry,
whatever speaks Streamable HTTP — kept next to your agents so the config is in one place.
Metro checks the server really answers an MCP `initialize`, stores the url and the optional
auth header, and hands the whole list to the [CLI](#the-metro-cli) as one `mcpServers` block.
That is the whole feature:
**Metro does not proxy a connector**, opens no session to it, exposes no tool for it, and
no agent's traffic goes through it.

Connectors belong to the **signed-in person**, not to an agent, so they live at `#/connectors`
in the panel rather than on an agent's page. Somebody else's connector and an id that never
existed are the same `404`.

Nothing is stored until the probe succeeds — **except for a server that demands OAuth**, which is
stored unverified so it appears in your list whether or not you finish signing in, and shows a
**Connect** button until you do. Otherwise Metro POSTs a real `initialize`, then
`notifications/initialized`, then `tools/list`, and records the server name, version,
protocol and tool count. A refusal by the remote while you are adding one is a `400` from
Metro with a plain reason — never a `401`, which is reserved for your own expired session.
Re-checking a connector that has stopped answering is a `200` carrying `ok: false`; the row
stays.

**The url must be public `https`.** Metro connects from its own server, so `localhost`, an
IP literal, and `.local`/`.internal` names are refused, as are `user:pass@` urls and
redirects. Nothing about the remote's answer is echoed back to you.

**No Metro API hands a connector credential to a browser.** `GET /api/connectors` carries no
stored header value, no OAuth access token and no `mcpServers` block, so the panel has nothing
to render and an open devtools window has nothing to take. The block that *does* carry the
credentials is attached only when the caller presents a **CLI session** — one minted by the
pairing code, which a browser session can never hold. The boundary is the kind of
token, not the route. Neither the url nor any value is ever logged. The webhook endpoint url is
now the only credential any Metro API returns.

### The metro CLI

`@stage-labs/metro` is the only published package in this repo. It exists so a machine with no
browser — a Linux box you reach over SSH — can hand a whole connector list to a coding session
without the credentials touching disk, argv or shell history.

```bash
npm i -g @stage-labs/metro@beta   # `latest` is an older line; the tag matters

metro login     # paste a pairing code for the agent
metro mcp       # prints {"mcpServers": {...}} on stdout: that agent's connectors, through the relay
metro whoami    # which account and agent this machine is signed in as
metro update    # update to the newest published version
```

Start a session with every connector, writing nothing to disk:

```bash
claude --mcp-config <(metro mcp)
```

`metro mcp` refreshes any OAuth access token that is at or near expiry before it prints, and
stores the refreshed pair, so a block you pipe into a client is live rather than an hour stale.
A token endpoint that will not answer is logged and that one connector goes out with what was
stored; the rest are unaffected.

Sign-in authorizes **one agent**, not your account: metro.box mints a single-use code for it
(`ma_` + 16 base64url, ten-minute TTL, in memory only) which you paste into `metro login`. The CLI trades it for a token. The same code
is what `metro start` takes, so one code pairs a machine whichever way you use it. There is no
localhost listener and no callback, which is exactly why it works over SSH. A server appears in
the client under the connector's own name, so rename one (from either kebab menu) if two of
them would collide.

**That token is not a session.** It is a distinct type (`typ: 'agent'`) carrying the agent it
was minted for, and `apiSession()` refuses it — so a token left on a shared box cannot read your
agents, cannot add or delete a connector, and cannot see any other agent. It can fetch its own
agent's `mcpServers` block, say who it is, and relay to the connectors that agent holds.
Nothing else. A machine running `metro start` uses its run token on the same routes, so it
needs no second sign-in.

Two environment variables matter: `METRO_URL` points at the daemon (default
`https://mcp.metro.box`) and `METRO_UI_URL` at the web UI (default `https://metro.box`). They
are different origins; the daemon serves no page.

### The Claude Code plugin

The same sign-in also works as a Claude Code plugin, for sessions that would rather not
shell out to `metro mcp`. This repository is its marketplace:

```bash
metro plugin    # claude plugin marketplace add bonustrack/metro, then claude plugin install metro@metro
```

Inside Claude Code, `/metro:login <code>` claims a pairing code from an agent's page and
writes the same `~/.config/metro/credentials.json` the CLI uses, so the two sign-ins are
interchangeable; `/metro:refresh` re-reads what the agent holds and rewrites the plugin's
server list. Plugin MCP registration is a snapshot, so after either one run `/reload-plugins`
(or `claude plugin update metro@metro`) for the servers to connect; `metro login` refreshes
the plugin by itself when it is installed. The generated server list carries no credential:
each entry names metro's relay url and a helper that prints the agent token fresh from the
credentials file on every connect, so a re-login propagates with nothing to regenerate.

### Running metro on your own machine

`metro start <agent-id>` runs that agent's stations on your machine instead of on
metro's servers, so **your messages never pass through them**. It authorizes on first run —
it prints a URL, you pick the agent in the browser and paste the code back — then caches the
credential and runs in the foreground, ready for systemd or launchd to supervise. Set
`METRO_RUN_TOKEN` to start unattended. A machine that runs an agent is also signed in as
it: `metro mcp` and `metro whoami` use the run token when no `metro login` sign-in is
stored, so one pairing code covers both.

`metro serve` is the other way to run a daemon here, with **nothing on metro.box at all**: its
agents and stations live in `~/.metro/agents` on this machine (the file mode described further
down), and the page at metro.box manages it through the link it prints. From another computer,
forward the port first (`ssh -L 8420:127.0.0.1:8420 <host>`); on a box already running
`metro start`, pick another port with `--port 8421`. `metro serve --tunnel` skips the forwarding:
it runs a Cloudflare quick tunnel (`cloudflared`, no account) and the link it prints carries a
public `https://…trycloudflare.com` address that works from any browser, behind NAT included.
The address changes on every start, Cloudflare terminates TLS and promises no uptime for quick
tunnels. The daemon only ever lets one wallet in, the one named with `--owner <address>` (asked
for once and remembered in `~/.metro/agents/.owner`); until an owner is set, every sign-in is refused.

Metro no longer runs messenger stations at all: they run on your machine or nowhere. There is
no fallback to Metro if your machine is down, which is the point. It needs
[Bun](https://bun.sh) on PATH, and it covers every messenger station — XMTP, Telegram,
Telegram user accounts, Discord and WhatsApp. Only **webhook endpoints** stay on metro, because
a third party has to be able to POST to them and your machine has no public URL; an agent
holding one is refused with a message saying so. While an agent runs locally, metro serves it
nothing — there is no fallback, and its key stops working against metro so a client pointed at
the wrong daemon fails loudly instead of going quiet.

**Without any account** (the base of the local-first work in `docs/LOCAL-FIRST.md`): start the
daemon with `METRO_MODE=local` and it reads its agents from `~/.metro/agents/<name>/agent.json`
(`METRO_AGENTS_DIR` overrides the directory), each `{ "version": 1, "id", "name", "key",
"owner", "stations": [...] }`, runs their stations on this machine and prints the paste-ready
line for Claude Code. No Postgres, no metro.box. It serves the same API as metro.box: sign in
with your wallet (only the one named with `metro serve --owner`), create agents and attach
stations, all written to those files. Open the link it prints: metro.box connects to the daemon on
your machine (from another computer, forward the port first with `ssh -L 8420:127.0.0.1:8420 <host>`)
and manages it from the same pages, while your messages stay on that machine. With the published
CLI this is `metro serve`; a checkout runs it as `METRO_MODE=local bun apps/mcp/src/server.ts`.
An agent that lives on metro.box can move here: *Import from metro.box* on the agent page lists
the wallet's agents, mints the pairing code itself (the same one `metro start` takes) and brings
the agent over with its stations, its connectors and their credentials, same id and same key, so
nothing changes on the Claude Code side; *Import again* refreshes an agent already here. Stop `metro start` for that agent first; metro.box keeps its copy until you
delete the agent there.

**Sync with Metro** keeps a copy of the agent on metro.box that metro.box cannot read: the page
fetches the agent, its stations, its connectors and their credentials from the daemon, seals them in
the browser to a key derived from one signature of the owner wallet (secp256k1, the Ethereum curve),
and stores only the sealed bundle. **Restore from Metro** on a fresh daemon downloads it, opens it
with the same signature, and hands the plaintext to that daemon, which writes the files and starts
the stations; the same id and key carry over. Only the owner wallet can open a bundle.

One thing to know about XMTP: an inbox allows ten installations and the first start on each
machine spends one, so metro prints a warning when it does. Restarts on the same machine reuse
it; only pairing new machines costs.

To be precise about what this does and does not buy: metro still stores your bot tokens, so
this stops your messages transiting metro — it does not stop metro being able to read them
from the platform directly.

### One agent, its connectors

The page is about one agent, the one the daemon in the address runs, and every connector on
that daemon is held by it: `metro mcp` exports them all, and deleting a connector removes it
from the agent. Two connectors may not share a name, because the name is the key in the
exported `mcpServers` block and a collision there would silently drop one of them; adding or
renaming one is refused `409` when it would collide.

### Inbound webhooks

A webhook endpoint is a `stations` row like any other station account, so it belongs to
one agent and its events reach only that agent. Attach one from the agent's page (or
`POST /api/agents/<id>/accounts/start` with `{"station":"webhook"}`); the `201` carries the
url.

```sh
curl -X POST "https://mcp.metro.box/api/webhooks/<webhook_id>/<token>" \
  -H "content-type: application/json" -d '{"hello":"world"}'
```

The whole URL is the credential — no signature header and nothing else to configure, so
any provider that takes a webhook URL works by pasting it in. Treat it like a password:
anyone holding it can post events to that agent.

The `<webhook_id>` is its own random 19-digit id, **not** the account id — an account id
encodes the agent it belongs to, and this URL gets pasted into other people's systems.

Anything that is not an exact token match is a `404`, compared in constant time. `GET` on
the same url answers a readiness line and emits nothing, so it is safe as a health check.
Events arrive on `metro://webhook/<account_id>` and are inbound-only — an agent cannot
`send`, `reply` or `react` on that line.

The agent is handed a `[webhook received]` note with the pretty-printed body, capped at
8 KiB, plus an allowlist of headers — a delivery's `authorization`, `cookie` and
`x-hub-signature-256` never reach the agent.

Detaching the account takes the url out of service at the next materialize. Because the
url is what you paste into a provider days later, it stays retrievable from the station's
page — the one station credential an API re-serves, to its owning agent only.

### Attaching station accounts from the web UI

Creating an agent does **not** create station accounts; a new agent starts empty.
`POST /api/agents/<id>/accounts/start` is the only route that writes the `stations` table.

| station | what you supply | what Metro checks before storing anything |
| --- | --- | --- |
| `discord-bot` | the bot token | `GET /users/@me` with `Authorization: Bot <token>`. A rejected token is a `400` at attach time, not a dead train at the next boot. `GET /applications/@me` is read too: the train always requests the **Message Content** intent, so an application without it is refused with the fix spelled out rather than crash-looping. If that second call cannot be read, the attach is allowed through. |
| `telegram-bot` | the bot token | `getMe`, which must answer `ok:true` for an `is_bot` identity. |
| `xmtp` | nothing | Metro generates the 32-byte secp256k1 key, then **opens an XMTP inbox with it** before the row is written — in a short-lived subprocess, against the same db3 the train will use, whose path is stored in `config.dbPath` so the train reuses the verified installation instead of burning a second of the inbox's ten. `inboxId` and `address` come back on the `201`. A failure is a `400` and the half-built database is deleted. |
| `telegram` | api id + api hash from my.telegram.org, then the phone number | The whole MTProto sign-in: a login code to that number, plus the two-step password if the account has one. |
| `whatsapp` | a phone number, or nothing to scan a QR | The whole multi-device pairing: Metro opens a Baileys socket, shows the QR or 8-character code, and waits for the handset. |
| `webhook` | nothing | Nothing to check — there is no provider. Metro generates the account id, mints a random webhook id and a token, and answers with the url. Live as soon as the row is written; no train is spawned. |

The last three of the first five cannot finish in one request, so `telegram` and
`whatsapp` run as a short-lived **attach session**:

| method | path | |
| --- | --- | --- |
| `POST` | `…/accounts/start` | answers `201 { status: "pending", attachId, step, prompt, qr, pairingCode, expiresAt }` |
| `GET` | `…/accounts/<attach_id>` | poll: the QR rotates, the step moves `code` → `password`, status becomes `done` or `failed` |
| `POST` | `…/accounts/<attach_id>/step` | `{"code":"…"}` or `{"password":"…"}` |
| `DELETE` | `…/accounts/<attach_id>` | abandon it now rather than waiting for the timeout |

`<attach_id>` is `as_` + 22 random base64url characters, disjoint from every station name,
so the router can tell an attach session from an account path without guessing.

Session state is **in memory only and never persisted**. It holds a live provider client —
the thing that holds the credential in flight — and the credential is handed straight to
the `stations` row on success, never stored on the session or returned in a poll. A session
lives five minutes, one agent may have two at a time and the daemon forty, and expiring,
cancelling or shutting down all tear the provider client down. Nothing is written until the
sign-in completes, so an abandoned attempt leaves no trace.

Rules that hold for every station:

- **No row exists unless the credential was demonstrated to work.** Every station checks
  against the real provider *before* the write, and a refusal leaves the table byte for
  byte as it was. If the write fails after a good check, whatever the check created on
  disk is discarded. "Well-formed" is never enough: a generated XMTP key is well-formed by
  construction, which is exactly why it is registered before it is stored.
- **Authorisation is the same predicate as delete.** `ownedAgentOrThrow` is one function
  used by both: the agent's `owner_id` must be the `users` row for the session subject.
  Somebody else's agent, an unknown id, or an operator-provisioned row is a flat `404`.
- **`account_id` is generated by the server** (`a<agent-id>-<8 hex>`), never taken from the
  request, so two people cannot collide in the shared primary key and nobody can probe
  which ids exist.
- **Station credentials are never returned again.** `GET /api/agents` re-serves
  `agents.key` for agents you own; `accounts.config` is deliberately not part of that
  exposure. The one exception here is the webhook endpoint url, which is useless if you
  cannot retrieve it — as is, elsewhere, a [connector](#connectors)'s auth header.
- **A duplicate bot token is `409`.** Two `telegram-bot` accounts sharing a token make the
  whole train refuse to boot, so the collision is caught at attach.
- **The station reloads immediately.** The daemon re-materialises the account files and
  asks the supervisor to reload just that station: restarting it, spawning it if this is
  its first account, stopping it when the last is detached. Train stubs are rewritten only
  when their content changes, so attaching a Telegram account does not restart XMTP. The
  response carries `activated: false` if the reload failed; the row is still valid.

**Is the generated XMTP key recoverable?** Not through Metro. It is stored in
`accounts.config.privateKey` in plaintext, so an operator with database access can read it,
but no API returns it again — the one-time panel at creation is the only copy. Copy it out
then, or treat the identity as disposable.

On a `METRO_AGENT`-pinned daemon a newly generated key is **not** accepted by that daemon.
It is still valid in the database and starts working as soon as a daemon that serves the
new agent runs.

Restrict who can drive an account via the `allowlist` column (default `['*']`):

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
e.g. `https://mcp.metro.box`), plus `GET /health` and the webhook receiver. Register it —
this is the line the control panel hands you, and it always names the daemon on the machine
you paste it into, so `metro start <agent-id>` there first (see
[Running metro on your own machine](#running-metro-on-your-own-machine)):

```sh
claude mcp add --transport http metro "http://127.0.0.1:8420/mcp?token=<the agent's key>"
```

An agent nobody has claimed is still served by metro itself at
`https://mcp.metro.box/mcp?token=<key>`; that is the shape for an agent that stays hosted,
such as one holding only a webhook.

Metro is a Claude Code **channel** — it pushes inbound chat into a running session. Start
Claude Code with the channel flag:

```sh
claude --dangerously-load-development-channels server:metro
```

Inbound messages then arrive as `<channel source="metro" line="…" …>text</channel>`
events; the agent replies with the tools above, and tool-approval prompts relay to the chat
so you can answer from your phone. (Requires Claude Code v2.1.80+ and claude.ai or Console
API auth.)

Inbound is only noticed between tool calls, so a session busy with a build or a grep
answers late. [Orchestrator-only main thread](docs/SETUP.md#orchestrator-only-main-thread)
is the optional configuration that fixes that.

If you turn Claude Code's telemetry off, read
[Privacy and data retention](docs/SETUP.md#privacy-and-data-retention) first. Disabling
telemetry also disables feature-flag evaluation, which disables channels, which stops
inbound delivery silently on the next reconnect — `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1`
is the fix.

### Monitor transport

The **Channel** above is the primary transport. The **Monitor** is an optional second,
lightweight live transport on the same port for tools that want to observe and drive Metro
over plain HTTP (no MCP client needed). It is **live-only by design** — no history,
backlog or replay — and can be attached mid-session.

It uses the same credential as `/mcp` and is **scoped like `/mcp`**: the tail carries only
events on the caller's own station accounts, and a call may only drive a line that belongs
to one of them. While the daemon holds no credential at all — no `agents.key` and no
`METRO_SESSION_SECRET` — the whole `/api/*` surface stays disabled (404).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/tail` | SSE stream of live bus events from the moment of connection (25s keepalive). No replay. |
| `POST /api/call/:train/:action` | Invoke a station verb over HTTP; returns the dispatch result as JSON. |
| `GET /api/health` | `{ ok, service, version, uptime_s }` snapshot, in front of the auth gate. |

```sh
curl -N -H "Authorization: Bearer $METRO_AGENT_KEY" http://127.0.0.1:8420/api/tail
curl -X POST -H "Authorization: Bearer $METRO_AGENT_KEY" \
  -H 'content-type: application/json' \
  -d '{"args":{"line":"metro://discord-bot/<account_id>/<channel_id>","text":"hi"}}' \
  http://127.0.0.1:8420/api/call/discord-bot/send
```

The line carries the scope, so it is required: a caller may only drive an account it owns,
and an `account` argument may not re-route the call to somebody else's. A call with no line
at all (`stations`) is served only when every account of that station belongs to the
caller.

### Attachment links

Inbound media is cached under `$HOME/.cache/metro/messenger-uploads` and surfaced on the
event as an absolute `/attach/<name>` url on `METRO_PUBLIC_URL`. The `?token=` in that url
is a **per-attachment token** — 32 CSPRNG bytes, good for that one file and nothing else.
It is **not** the agent's key: a delivered link travels through chat history, logs and
archives, and must not be a copy of a credential that opens `/mcp`.

When the daemon mints the url it writes two 0600 sidecars beside the cached file: `.owner`
(the agent id) and `.grant` (the token, bound to that same agent id). `/attach` serves the
file on either of two paths, and both re-check the owner: the caller presents that
attachment's own token, or authenticates as an identity scoped to the owning agent.
Anything else — another attachment's token, another agent's key, a missing token, an
attachment with no recorded owner — is a flat `401`, never a serve. The capability path
fails closed: no `.grant` means no token can match.

Because the link's authority is its own token, **resetting an agent's key does not break
links already handed out.**

### Sending a file out

An attachment on `send` names exactly one source, and only one of them is right for the
normal case — a file sitting on the machine the agent runs on:

| Source | Use it when | Why not otherwise |
| --- | --- | --- |
| `upload` | **almost always**, up to 64 MiB | — |
| `data` | the file is a few KB at most | the base64 has to be written out verbatim inside the tool call, and a model cannot emit tens of thousands of characters of it without corrupting them. Measured practical ceiling: roughly 10 KB, far below the 8 MiB the daemon would accept |
| `url` | the file is already published | the daemon fetches it, so it must be publicly reachable — which rules it out for anything confidential |
| `path` | the file is already on the daemon host | it resolves on the **daemon's** filesystem, not the caller's |

The `upload` route moves the bytes over HTTP, straight from the caller's disk to the
daemon, so they never pass through the model's context and nothing is published:

```bash
# 1. MCP, no shell needed: mint a slot
#    create_upload({name: "q3-results.pdf"})
#    -> { upload_id: "up_…", upload_url: "https://mcp.metro.box/api/uploads/up_…?token=ut_…", curl: "…" }

# 2. the one step that needs a shell — push the bytes
curl -sS -T q3-results.pdf "https://mcp.metro.box/api/uploads/up_…?token=ut_…"

# 3. MCP again: attach it
#    send({line, text: "the numbers", attachments: [{upload: "up_…"}]})
```

Step 2 needs a shell and there is no way around it: anything carried in an MCP call is
model output by construction, so an MCP-only path puts the bytes back through the model —
which is the problem `data` already has. An agent that cannot run commands should delegate
that single line to one that can and keep the `upload_id`; the slot belongs to the metro
**agent**, not to whoever ran the command.

With the agent's key to hand you can skip `create_upload` and post the file in one request:

```bash
curl -sS -H "Authorization: Bearer $METRO_AGENT_KEY" \
     --data-binary @q3-results.pdf \
     "https://mcp.metro.box/api/uploads?name=q3-results.pdf"
```

An upload is **owned by the uploading agent and scoped exactly like an attachment**: the
same sidecars, the same two-path check, and `send` re-checks the owner before resolving the
id. Another agent naming the id gets the same answer as one naming an id that never
existed.

Uploads are **transient**: they live in the daemon's temp directory, never in the durable
cache `/attach` serves, they expire **30 minutes** after creation, and a reaper sweeps every
60 seconds. `DELETE /api/uploads/<id>` drops one early. A successful `send` does *not*
consume the upload, so a retry after a timed-out call still works.

Limits: **64 MiB per file** and 512 MiB of pending uploads daemon-wide. Over either, the
request is refused with an error naming the limit — never truncated. Stations impose their
own lower ceilings on top (XMTP refuses non-image files over ~190 KiB), and those fire
first.

## How it works

One process does everything: a **supervisor** spawns and multiplexes the station
subprocesses, and the **MCP** is served in the same process — the dispatcher publishes
inbound events to an in-process event bus, the inbound relay subscribes and pushes
`notifications/claude/channel`, and outbound dispatches straight to the stations.

Inbound is never journaled to disk: events go to an in-memory bus
([`events.ts`](apps/mcp/src/daemon/events.ts)) and the relay subscribes. The MCP HTTP
transport is session-tolerant: it survives a daemon restart so connected sessions
auto-resume.

**Lines.** Every conversation is a `metro://<station>/<path>` URI — the station is the
host, the path is platform-specific (account-scoped for multi-bot). One parser
([`lines.ts`](apps/mcp/src/stations/lines.ts)) owns the scheme.

**Envelope.** Inbound and outbound events share one shape, see
[`protocol.ts`](apps/mcp/src/daemon/protocol.ts).

**State.** Metro is stateful and needs a persistent volume: the XMTP MLS databases under
`~/.metro/` and the IPC socket under `$METRO_STATE_DIR` (default `~/.cache/metro`).

## Development

```sh
bun run build      # tsc -> dist/
bun run typecheck
bun run lint
bun run knip
bun run madge
bun run test
```

All six must pass before a PR.

## Project structure

A bun-workspaces + turborepo monorepo: the core daemon lives in `apps/mcp`, the control
panel in `apps/ui`, and each messaging platform is a private station package.

```
apps/
  mcp/                  # @metro-labs/mcp — the core daemon
    src/
      server.ts         # entry (bin: metro-daemon) — imports daemon/boot
      daemon/           # supervisor + HTTP (/health, /mcp, /api/…) + IPC + bus
      mcp/              # the MCP protocol surface + per-identity sessions
      channels/         # the inbound relay: bus events -> channel notifications
      monitor/          # the lightweight live HTTP transport
      stations/         # the station contract, registry, account store, attachments
      db/               # drizzle schema, materialize, agent/key maps, scope predicate
  ui/                   # the control panel (Vite + react-native-web)

packages/               # private station packages, each implementing the contract
  xmtp/  telegram-bot/  telegram/  discord-bot/  whatsapp/  webhook/
```

The station contract and runtime live in the core and are re-exported via
`@metro-labs/mcp/stations/*`; the platform packages depend only on `@metro-labs/mcp` and
stay isolated (the XMTP node SDK never enters the core graph). See the per-package READMEs:
[apps/mcp](apps/mcp/README.md), [apps/ui](apps/ui/README.md),
[xmtp](packages/xmtp/README.md), [telegram-bot](packages/telegram-bot/README.md),
[telegram](packages/telegram/README.md), [discord-bot](packages/discord-bot/README.md),
[whatsapp](packages/whatsapp/README.md), [webhook](packages/webhook/README.md).

## License

MIT
