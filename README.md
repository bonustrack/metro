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

## Channels

A **channel** is a chat-platform integration. Each is a `stations` row in Postgres, and
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
METRO_MODE=local bun apps/mcp/src/server.ts   # a daemon of your own on http://127.0.0.1:8420
```

A local daemon reads its agents from `~/.metro/agents/<name>/agent.json` (see
[Where things live](#where-things-live)) and materializes one one-line train file per active
channel under `apps/mcp/trains/*.ts` (`METRO_TRAINS_DIR` overrides), then the supervisor spawns
and hot-reloads one subprocess per file:

```ts
// apps/mcp/trains/xmtp.ts   (generated from the agent files — you don't hand-write these)
import '@metro-labs/xmtp/train';
```

The hosted daemon at `mcp.metro.box` is the same program without `METRO_MODE=local`: it runs no
channel, and serves wallet sign-in, the [vault](#sync-with-metro-and-restore) and `/health`
from Postgres (`bun run start` with `DATABASE_URL` set).

## Deploying

The hosted daemon is a Fly app holding one Postgres database (wallets and the vault) and
nothing else of yours. Once:

```sh
# edit app = "metro" in fly.toml to a unique name first
fly apps create <your-app-name>
fly volumes create metro_data --size 3 --region iad
export DATABASE_URL=postgres://user:pass@host:5432/metro
bun --filter @metro-labs/mcp db:migrate
fly secrets set DATABASE_URL="$DATABASE_URL"
fly deploy
fly certs add mcp.example.com   # optional: then add the records Fly prints at your DNS provider
```

Merging to `main` deploys. **Every deploy is a brief outage** (40–90s observed); the daemon
runs no channel any more, so nothing but the page and the vault notice. Keep it to one machine
(`fly scale count 1`) and always on (`auto_stop_machines = false`), which `fly.toml` already
says.

## Configuration

### Where things live

A daemon owns its agents outright, as files under `~/.metro/agents` (`METRO_AGENTS_DIR`
overrides), all `0600`:

- **`<name>/agent.json`** — `{ "version": 1, "id", "name", "key", "owner", "stations": [...],
  "connectors": [...] }`. `id` is the identity every scoping decision compares (an
  11-character URL-safe id, like a YouTube video id); `key` is the agent's one and only API key,
  `mk_…`; `stations` carries each channel account with its `config` and `allowlist`;
  `connectors` lists the ids of the connectors the agent holds.
- **`connectors.json`** — the daemon's connectors, `{ id, name, url, transport, config }` each,
  `config` holding the auth header or the OAuth tokens.
- **`.owner`** — the one wallet allowed to sign in, written by `metro serve --owner`.
- **`~/.metro/runtime`** — metro's code plus the SDKs of the channels this agent has, installed
  by `metro serve` with `bun`; the npm package itself ships none of them.

Per-channel `config` (connection secrets + optional `owner`):

| channel | `config` fields |
| --- | --- |
| `xmtp` | `{ privateKey }` (raw EOA key); optional `dbPath` |
| `telegram-bot` | `{ token }` |
| `telegram` | `{ session, apiId, apiHash }` |
| `discord-bot` | `{ token }` |
| `whatsapp` | `{ phone }` (E.164 digits) plus the Baileys auth blob under `credentials` |

Channel ids are the channel's public handle: they appear in `metro://` lines
(`metro://telegram-bot/<account>/<chat>`, so replies go back out the same identity) and in the
WhatsApp token filename. The `allowlist` is the sender ids allowed to drive that account's
session; inbound from anyone else is dropped. It gates the relay only and is stripped from the
train files.

`agents.key` is the whole API-key story: at boot the daemon indexes every key by SHA-256, and a
request presenting one is authenticated as that agent and **scoped to that agent's accounts
only**, on `/mcp`, on the Monitor transport, on `/attach` and on the relay. Inbound events are
tagged with the owning agent and delivery is scoped to it; an event arriving while its agent is
disconnected is held and replays on the next connect (bounded by the in-memory ring buffer).

**metro.box keeps two tables** ([`schema.ts`](apps/mcp/src/db/schema.ts)): `users` (one row per
wallet that ever signed in) and `vault` (one sealed bundle per agent, see
[Sync with Metro and Restore](#sync-with-metro-and-restore)). No channel, no connector and no
key is stored there in the clear; migrations `0021` and `0022` added the vault and dropped
everything else. `DATABASE_URL` is the hosted daemon's only secret.

**Migrations apply themselves on deploy.** `fly.toml` sets a `release_command`, so Fly runs
`bun --filter @metro-labs/mcp db:migrate` in a temporary machine with the app's secrets before
the new version goes live. If it fails the deploy is **aborted** and the old machine keeps
serving. `drizzle-kit` is therefore a runtime dependency, present in the production image. By
hand, against any database you can reach:

```bash
DATABASE_URL='postgres://…' bun --filter @metro-labs/mcp db:migrate
```

### The daemon's API

[`apps/ui`](apps/ui), the page at metro.box, manages **one local daemon**, the one in its
address (`https://metro.box/#/<host:port>`), through JSON routes that take a signed request, mounted
before the MCP auth gate:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/mode` | `{ mode, owner, project, version }`, unauthenticated: what the page reads first. |
| `POST /auth/identity` | Registers the identity the page derived from the owner wallet's signature. Only the owner wallet passes. |
| `GET /api/agents?project=localdaemon` | The agents here, each with its `connector_ids`; with `&accounts=1` their accounts and channel capabilities. An owned agent carries its key value and the paste-ready `claude mcp add …` command. |
| `POST /api/agents` `{"name":"…"}` | Create an agent, mint its key, return both with the paste-ready command. |
| `DELETE /api/agents/<id>`, `POST /api/agents/<id>/key` | Delete an agent (refused while channels are attached), reset its key. |
| `POST /api/agents/<id>/accounts/start`, `DELETE …/accounts/<station>/<account_id>` | Attach a channel account after checking the credential against the provider; detach one. |
| `GET /api/agents/<id>/bundle`, `POST /api/agents/restore` | The whole agent as one plaintext bundle, for the page to seal; and the reverse, for a bundle the page opened. |
| `GET`/`POST /api/connectors`, `POST /<id>/verify`, `/connect`, `/disconnect`, `/rename`, `DELETE /<id>` | The daemon's [connectors](#connectors). Carries **no credential**. |
| `GET`/`POST /api/agents/<id>/connectors`, `DELETE …/<connectorId>` | What an agent holds. Every connector is held by every agent on the daemon from creation. |
| `GET /api/cli/mcp`, `/api/cli/session`, `/api/cli/connectors` | Agent key only: the `mcpServers` block pointing at this daemon's relay, who it is, and its connectors. |
| `POST`/`GET`/`DELETE /relay/<connector-id>` | Agent key only: MCP passthrough to the connector, the vendor credential injected here. |
| `GET /api/claude/projects`, `/sessions`, `/memory`, `DELETE /api/claude/sessions/<id>` | Claude Code's own session transcripts and memory files on this machine, read-only apart from delete. |
| `GET`/`POST /api/update` | Whether a newer metro is published, and update this machine to it: the daemon runs `metro update` and restarts itself on the new version. The agent page shows the version with an **Update** button. |

On metro.box the same program serves sign-in (open to any wallet) and
`GET /api/vault`, `PUT`/`GET`/`DELETE /api/vault/<agentId>` — see
[Sync with Metro and Restore](#sync-with-metro-and-restore). Nothing else answers there.

Sign-in is one signature. The owner wallet signs a small typed message once (`EncryptionKey`,
the same one that seals agents on metro.box); the page derives two keys from it in the browser,
the key that encrypts your agent and an identity key that signs every request to the daemon
(`Authorization: Metro <address> <time> <signature>`), and keeps the signature in this browser
so you are not asked again. `POST /auth/identity` hands the daemon that signature once: it
checks it against the owner wallet and remembers the derived identity until it restarts, when
the page registers it again on its own. The login page offers every wallet extension the browser announces (MetaMask, Rabby,
…), **WalletConnect** for the wallet app on your phone (a Reown project id is built in;
`VITE_WC_PROJECT_ID` overrides it at build time) and **Coinbase Wallet**. Externally owned
accounts only; a smart-contract wallet is refused with a message saying so.

**The key value is served for the agents here, and the page masks it** behind a **Reveal**
toggle and copies it without revealing it. **Resetting a key** mints a new one and revokes the
old one in one step, with no overlap window. **Deleting** an agent that still has channels
attached is refused `409`; deletion never cascades into channel credentials.

### Connectors

A connector is a **verified bookmark for someone else's MCP server** — Linear, Snapshot,
whatever speaks Streamable HTTP — kept on your daemon so Claude Code gets the whole list as
one `mcpServers` block. The daemon checks the server really answers an MCP `initialize`, stores
the url and the credential in `connectors.json`, and **relays the traffic itself**: each entry
of the block points at `http://127.0.0.1:8420/relay/<id>` with the agent's key, the daemon
injects the vendor credential per request and refreshes OAuth tokens on its own. No connector
credential ever reaches Claude Code's config, the browser, or metro.box.

Nothing is stored until the probe succeeds — **except for a server that demands OAuth**, which is
stored unverified so it appears in your list whether or not you finish signing in, and shows a
**Connect** button until you do. The OAuth flow lands on the daemon's own address, loopback or
tunnel. A refusal by the remote while you are adding one is a `400` with a plain reason, never
a `401`, which is reserved for a request the daemon could not attribute to its owner. Re-checking a connector that has
stopped answering is a `200` carrying `ok: false`; the row stays. A connector name is unique on
the daemon (`409` at create and rename) because it is the key in the exported block. On a local
daemon `http://` and private hosts are allowed: local MCP servers are the point.

### The metro CLI

`@stage-labs/metro` is the only published package in this repo. It carries the daemon runtime
and the commands around it:

```bash
npm i -g @stage-labs/metro@beta   # `latest` is an older line; the tag matters

metro serve --tunnel --owner 0x…   # run the daemon; the page at metro.box manages it through the link it prints
metro stop      # stop it
metro mcp       # print {"mcpServers": {...}}: the agent's connectors, through the daemon's relay
metro whoami    # which agent this machine runs
metro tail <agent-id>   # follow this machine's inbound events as JSON lines
metro update    # update to the newest published version
```

Start a session with every connector, writing nothing to disk:

```bash
claude --mcp-config <(metro mcp)
```

`metro mcp` and `metro whoami` read `~/.metro/agents` and talk to the daemon on this machine
with the agent's own key; there is no sign-in and nothing to pair. `METRO_AGENTS_DIR` and
`METRO_WEBHOOK_PORT` are the only knobs they read.

### The Claude Code plugin

The same connector list also works as a Claude Code plugin, for sessions that would rather not
shell out to `metro mcp`. This repository is its marketplace:

```bash
metro plugin    # claude plugin marketplace add bonustrack/metro, then claude plugin install metro@metro
```

Inside Claude Code, `/metro:refresh` reads what the agent on this machine holds from the local
daemon and rewrites the plugin's server list. Plugin MCP registration is a snapshot, so run
`/reload-plugins` (or `claude plugin update metro@metro`) afterwards for the servers to connect.
The generated list carries no credential: each entry names the daemon's relay url and a helper
that prints the agent key fresh from the agent file on every connect.

### Running metro on your own machine

`metro serve` runs a daemon with **nothing on metro.box at all**: the agent, its channels and its
connectors live in `~/.metro/agents` on this machine, and the page at metro.box manages it
through the link it prints. From another computer, forward the port first
(`ssh -L 8420:127.0.0.1:8420 <host>`). `metro serve --tunnel` skips the forwarding: it runs a
Cloudflare quick tunnel (`cloudflared`, no account) and the link it prints carries a public
`https://…trycloudflare.com` address that works from any browser, behind NAT included. The
address changes on every start, Cloudflare terminates TLS and promises no uptime for quick
tunnels. The daemon only ever lets one wallet in, the one named with `--owner <address>` (asked
for once and remembered in `~/.metro/agents/.owner`); until an owner is set, every sign-in is
refused. It needs [Bun](https://bun.sh) on PATH and covers every messenger channel: XMTP,
Telegram, Telegram user accounts, Discord and WhatsApp. The npm package carries only metro's own
code: the first `metro serve` installs, into `~/.metro/runtime`, the SDKs of the channels the
agent actually has, and an update that changes no SDK downloads under a megabyte. Metro's servers run no channel and see
no message; there is no fallback if your machine is down, which is the point.

### Sync with Metro and Restore

**Sync with Metro** on the agent page keeps a copy of the agent on metro.box that metro.box
cannot read: the page fetches the agent, its channels, its connectors and their credentials from
the daemon, seals them in the browser to a key derived from one EIP-712 signature of the owner
wallet (secp256k1, Ethereum's curve; a random data key per seal, AES-256-GCM, the data key wrapped
to the wallet's public key), and stores only the sealed bundle. **Restore from Metro** on a
fresh daemon lists the wallet's bundles, downloads one, opens it with the same signature, and
hands the plaintext to that daemon, which writes the files and starts the channels; the same id
and key carry over, so the `claude mcp add` line does not change. Only the owner wallet can
open a bundle; the derived key lives in the browser for the duration of one action and is never
stored or sent.

One thing to know about XMTP: an inbox allows ten installations and the first start on each
machine spends one, so metro prints a warning when it does. Restarts on the same machine reuse
it; only pairing new machines costs.

### One agent, its connectors

The page is about one agent, the one the daemon in the address runs, and every connector on
that daemon is held by it: `metro mcp` exports them all, and deleting a connector removes it
from the agent. Two connectors may not share a name, because the name is the key in the
exported `mcpServers` block and a collision there would silently drop one of them; adding or
renaming one is refused `409` when it would collide.

### Inbound webhooks

The webhook channel is **off until metro.box can forward deliveries to your daemon**: a webhook
endpoint needs a stable public URL that providers can be given, which a machine behind NAT or a
quick tunnel does not have, and metro.box no longer stores channels. The channel code stays
(`POST /api/webhooks/<webhook_id>/<token>`, the whole URL being the credential, events on
`metro://webhook/<account_id>` with the pretty-printed body and an allowlist of headers); a
local daemon refuses to attach one, with a message saying so. The forwarding design is the next
slice in [`docs/LOCAL-FIRST.md`](docs/LOCAL-FIRST.md).

### Attaching channel accounts from the web UI

Creating an agent does **not** create channel accounts; a new agent starts empty.
`POST /api/agents/<id>/accounts/start` is the only route that writes a channel into the agent file.

| channel | what you supply | what Metro checks before storing anything |
| --- | --- | --- |
| `discord-bot` | the bot token | `GET /users/@me` with `Authorization: Bot <token>`. A rejected token is a `400` at attach time, not a dead train at the next boot. `GET /applications/@me` is read too: the train always requests the **Message Content** intent, so an application without it is refused with the fix spelled out rather than crash-looping. If that second call cannot be read, the attach is allowed through. |
| `telegram-bot` | the bot token | `getMe`, which must answer `ok:true` for an `is_bot` identity. |
| `xmtp` | nothing | Metro generates the 32-byte secp256k1 key, then **opens an XMTP inbox with it** before the row is written — in a short-lived subprocess, against the same db3 the train will use, whose path is stored in `config.dbPath` so the train reuses the verified installation instead of burning a second of the inbox's ten. `inboxId` and `address` come back on the `201`. A failure is a `400` and the half-built database is deleted. |
| `telegram` | api id + api hash from my.telegram.org, then the phone number | The whole MTProto sign-in: a login code to that number, plus the two-step password if the account has one. |
| `whatsapp` | a phone number, or nothing to scan a QR | The whole multi-device pairing: Metro opens a Baileys socket, shows the QR or 8-character code, and waits for the handset. |

The last two cannot finish in one request, so `telegram` and `whatsapp` run as a short-lived
**attach session**:

| method | path | |
| --- | --- | --- |
| `POST` | `…/accounts/start` | answers `201 { status: "pending", attachId, step, prompt, qr, pairingCode, expiresAt }` |
| `GET` | `…/accounts/<attach_id>` | poll: the QR rotates, the step moves `code` → `password`, status becomes `done` or `failed` |
| `POST` | `…/accounts/<attach_id>/step` | `{"code":"…"}` or `{"password":"…"}` |
| `DELETE` | `…/accounts/<attach_id>` | abandon it now rather than waiting for the timeout |

`<attach_id>` is `as_` + 22 random base64url characters, disjoint from every channel name,
so the router can tell an attach session from an account path without guessing.

Session state is **in memory only and never persisted**. It holds a live provider client —
the thing that holds the credential in flight — and the credential is handed straight to
the agent file on success, never stored on the session or returned in a poll. A session
lives five minutes, one agent may have two at a time and the daemon forty, and expiring,
cancelling or shutting down all tear the provider client down. Nothing is written until the
sign-in completes, so an abandoned attempt leaves no trace.

Rules that hold for every channel:

- **No account exists unless the credential was demonstrated to work.** Every channel checks
  against the real provider *before* the write, and a refusal leaves the file byte for byte
  as it was. "Well-formed" is never enough: a generated XMTP key is well-formed by
  construction, which is exactly why it is registered before it is stored.
- **Only the owner wallet may attach or detach**, the same predicate every route uses; a
  stranger's session gets the same `404` as an unknown agent.
- **The account id is generated by the server**, never taken from the request.
- **Channel credentials are never returned again.** `GET /api/agents` re-serves the agent's
  key; a channel's `config` is deliberately not part of that exposure. The bundle route hands
  the whole agent to the owner, for the page to seal.
- **A duplicate bot token is `409`.** Two `telegram-bot` accounts sharing a token make the
  whole train refuse to boot, so the collision is caught at attach.
- **The channel reloads immediately.** The daemon re-materialises the account files and
  asks the supervisor to reload just that channel: restarting it, spawning it if this is
  its first account, stopping it when the last is detached. Train stubs are rewritten only
  when their content changes, so attaching a Telegram account does not restart XMTP. The
  response carries `activated: false` if the reload failed; the row is still valid.

**Is the generated XMTP key recoverable?** Yes, twice over: it is in the agent file on the
daemon's disk, and in every bundle you sync. No API returns it on its own, though — the
one-time panel at creation is the only place it is shown.

The `allowlist` of a channel account (default `["*"]`) is edited in the agent file:

```json
{ "station": "xmtp", "id": "…", "allowlist": ["<sender-id>"], "config": { … } }
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
this is the line the agent page hands you, and it names the daemon on the machine you paste
it into (see [Running metro on your own machine](#running-metro-on-your-own-machine)):

```sh
claude mcp add --transport http metro "http://127.0.0.1:8420/mcp?token=<the agent's key>"
```

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
events on the caller's own channel accounts, and a call may only drive a line that belongs
to one of them. While the daemon holds no agent key at all, the whole `/api/*` surface stays
disabled (404).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/tail` | SSE stream of live bus events from the moment of connection (25s keepalive). No replay. |
| `POST /api/call/:train/:action` | Invoke a channel verb over HTTP; returns the dispatch result as JSON. |
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
at all (`stations`) is served only when every account of that channel belongs to the
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
request is refused with an error naming the limit — never truncated. Channels impose their
own lower ceilings on top (XMTP refuses non-image files over ~190 KiB), and those fire
first.

## How it works

One process does everything: a **supervisor** spawns and multiplexes the channel
subprocesses, and the **MCP** is served in the same process — the dispatcher publishes
inbound events to an in-process event bus, the inbound relay subscribes and pushes
`notifications/claude/channel`, and outbound dispatches straight to the channels.

Inbound is never journaled to disk: events go to an in-memory bus
([`events.ts`](apps/mcp/src/daemon/events.ts)) and the relay subscribes. The MCP HTTP
transport is session-tolerant: it survives a daemon restart so connected sessions
auto-resume.

**Lines.** Every conversation is a `metro://<station>/<path>` URI — the channel is the
host, the path is platform-specific (account-scoped for multi-bot). One parser
([`lines.ts`](apps/mcp/src/channels/lines.ts)) owns the scheme.

**Envelope.** Inbound and outbound events share one shape, see
[`protocol.ts`](apps/mcp/src/daemon/protocol.ts).

**State.** A daemon is stateful: the agent files under `~/.metro/agents`, the XMTP MLS
databases under `~/.metro/` and the lock under `$METRO_STATE_DIR` (default `~/.cache/metro`).

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
panel in `apps/ui`, and each messaging platform is a private channel package.

```
apps/
  mcp/                  # @metro-labs/mcp — the core daemon
    src/
      server.ts         # entry — imports daemon/boot
      daemon/           # supervisor + HTTP (/health, /mcp, /api/…) + IPC + bus
      mcp/              # the MCP protocol surface + per-identity sessions
      channels/         # the inbound relay: bus events -> channel notifications
      monitor/          # the lightweight live HTTP transport
      stations/         # the station contract, registry, account store, attachments
      db/               # the agent files, local connectors, agent/key maps, scope predicate; drizzle schema for users + vault
  ui/                   # the page at metro.box (Vite + react-native-web)

packages/cli/           # @stage-labs/metro — the published CLI, carrying the daemon runtime
plugin/                 # the Claude Code plugin; the repo is its marketplace

packages/               # private station packages, each implementing the contract
  xmtp/  telegram-bot/  telegram/  discord-bot/  whatsapp/  webhook/
```

The channel contract and runtime live in the core and are re-exported via
`@metro-labs/mcp/stations/*`; the platform packages depend only on `@metro-labs/mcp` and
stay isolated (the XMTP node SDK never enters the core graph). See the per-package READMEs:
[apps/mcp](apps/mcp/README.md), [apps/ui](apps/ui/README.md),
[xmtp](packages/xmtp/README.md), [telegram-bot](packages/telegram-bot/README.md),
[telegram](packages/telegram/README.md), [discord-bot](packages/discord-bot/README.md),
[whatsapp](packages/whatsapp/README.md), [webhook](packages/webhook/README.md).

## License

MIT
