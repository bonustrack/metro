# Mail as MCP servers (plan, 2026-11-09)

Status: proposal, nothing built. Part of `docs/CHANNELS-AS-CONNECTORS.md`, which it changes
in one way: mail goes first, and it leaves both the box and Metro's own services.

Gmail and Outlook stop being stations on the box. Each becomes its own remote MCP server on
Cloudflare Workers, in the `stagelabs/mcps` repository. Metro adds a mailbox like any other
connector (Granola, SharePoint), so its tools, rules, approvals and activity are the
connector ones. New mail reaches the agent the standard MCP way (`notifications/claude/channel`),
and the only new code in Metro is generic: support for live events from any remote MCP server.

## Owner's decisions (Less, 2026-11-08 and 2026-11-09)

- **Gmail and Outlook first**, as the simplest channels.
- **Not on the box, not in Metro's services** (api.metro.box, mcp.metro.box): separate MCP
  servers on Cloudflare Workers, in `stagelabs/mcps`.
- **Two Workers**, one per provider.
- **New mail arrives by push**, not by polling.
- **Everything ships together**: the tools, push, and live mail to the agent, with Metro's
  support for live events from a remote MCP server.
- **Existing mailboxes** may connect again or have their tokens moved; this plan connects
  them again (see Moving the mailboxes).
- From the channel plan, still true here: Metro checks the allowlist on every channel, one
  agent per channel, and the activity log has a row per call and per received message, never
  the text and never the sender. Email never carries approvals (`approvals: false` today).

## What exists today

- **On the box**: `packages/gmail` and `packages/outlook` run as trains. Each polls every
  30 s (Gmail `users.history.list`, Outlook Graph delta on the Inbox) and keeps its refresh
  token on the box: Outlook in `outlook-state-<account>.json`, Gmail in the account config,
  with the Workspace's own client secret when it uses one. Managed Gmail (Metro's own Google
  app, `apps/api/src/gmail`, off until `METRO_GMAIL_ENABLED=true`) renews the token on
  api.metro.box, but the refresh token still sits on the box. Scopes: Outlook `Mail.ReadWrite`,
  `Mail.Send`, `User.Read`, `offline_access`, `openid` on `/common`; Gmail `gmail.readonly`, and
  `gmail.send` only after a second consent.
- **In `stagelabs/mcps`**: one Worker per server (`servers/<name>`, `wrangler.jsonc`, address
  `mcp.<name>.piston.box`, deployed by Workers Builds). `servers/sharepoint` is the model: the
  MCP server is its own OAuth server (`@cloudflare/workers-oauth-provider`, grants in KV,
  dynamic client registration), signs in to Microsoft behind it with PKCE, keeps the Microsoft
  tokens in the grant's `props` and renews them when the client refreshes its own token. Its MCP
  handler is stateless: POST only, JSON answers, no stream.
- **In Metro**: a connector is reached only through mcp.metro.box (`tool_search`,
  `tool_call`), which already signs in to a server like SharePoint over MCP OAuth. Nothing in
  Metro listens to events from a connector.

## Overview

```
Gmail (Pub/Sub push) / Microsoft Graph (webhook)
        │ "the mailbox changed"
        ▼
gmail-mcp / outlook-mcp Worker ── mailbox Durable Object: tokens, cursor, renewals, event log
        │ notifications/claude/channel on the MCP stream (SSE, with event ids)
        ▼
mcp.metro.box ── holds the stream, checks the sender, writes the activity row
        │ signed long poll (like approvals today)
        ▼
the agent's box ── notifications/claude/channel to the session
        ▲
        │ tool_call gmail.reply (from a worker)
the agent ──► box ──► mcp.metro.box ──► Worker ──► Gmail or Graph
```

## The two Workers (`stagelabs/mcps`)

### Shape

- `servers/gmail` (Worker `gmail-mcp`, `mcp.gmail.piston.box`) and `servers/outlook` (Worker
  `outlook-mcp`, `mcp.outlook.piston.box`), laid out like `servers/sharepoint`: the OAuth
  provider, a consent page, the upstream sign-in, `stage.config.js` entries, Workers Builds.
- The repository's checks apply (`@stage-labs/config`: no comments, strict types, knip,
  madge). The mail code from Metro's core (`stations/mail`, `mail-text`, `mail-trust`, the
  Gmail and Graph calls) is copied in, not imported: the two repositories do not share
  packages, and the box versions go away at the end.

### Sign-in

- **Outlook**: a new Microsoft app registration for the Worker (confidential, Web platform,
  redirect `https://mcp.outlook.piston.box/callback`, the same scopes as today, authority
  `/common` so Outlook.com works too). Not the "Metro Mail" app: its `https://metro.box/`
  redirect must stay a public-client one (the trap in `CLAUDE.md`).
- **Gmail**: Metro's Google app from managed Gmail, with the Worker's redirect added and its
  client id and secret as Worker secrets. Read-only by default; sending is an open question
  below.
- **Upstream tokens live in the mailbox's Durable Object, encrypted with a Worker secret.**
  `workers-oauth-provider` encrypts `props` with a key only the token holder can unwrap, so
  a push handler or a renewal timer, which run without a client request, could not read them
  there. The grant's `props` hold only the mailbox id and address.

### The mailbox Durable Object

One per mailbox (keyed by the provider's account id), holding: the upstream tokens, the read
position (Gmail `historyId`, Graph delta link) and the ids already delivered, the push
subscription and its renewal timer, the event log for replay, and the grants that use it (two
Metro connectors on the same mailbox share one watch). A first sync records the position and
emits nothing, as today.

### Tools

The verbs of today's stations, with `readOnlyHint` on reads so Metro's Read and Write rules
apply:

- `send`: a new email to an address (subject from the argument, else the first line), or
  reply-all on a thread; answers the thread id.
- `reply`: answers one message.
- `read`: a thread, a search (`query`, `from`, `since`, `until`, `unread_only`) or one message
  in full. Outlook marks a message read when it is read in full, as today; Gmail never changes
  the mailbox.
- Attachments: inbound files go to an R2 bucket and come back as signed links (7 days, like the
  box cache); outbound files are an https URL or small inline data, with today's caps (Outlook
  3 MB each, Gmail 25 MB in all), refused before anything is sent.
- Automated mail is skipped by default, and every message carries `sender_verified` from the
  same `Authentication-Results` rules as today.

### Push

Push only says "this mailbox changed". The Durable Object then reads from its position, as the
trains do today, so a repeated or missed push does no harm. An hourly safety read catches a
subscription that broke without telling us.

- **Gmail**: `users.watch` on the Inbox, publishing to a Pub/Sub topic in Metro's Google
  project (Gmail's push service account may publish there), with a push subscription to
  `https://mcp.gmail.piston.box/push` that sends a Google-signed OIDC token, which the Worker
  checks (issuer, audience, service account). A watch lasts 7 days; the Durable Object renews
  it every day.
- **Outlook**: a Graph subscription on the Inbox's messages (`created`), plain notifications
  (with message content they last one day and need a certificate), a secret `clientState`, the
  validation handshake, and a lifecycle address for `reauthorizationRequired`, `missed` and
  `subscriptionRemoved`. It lasts at most 10,080 minutes; the Durable Object renews it every
  day.

### Live events

- `initialize` declares `experimental['claude/channel']` and the Metro extension
  `experimental['metro/channel']: {sender: 'from', chat: 'thread_id'}`, never
  `claude/channel/permission`.
- Each new message is a `notifications/claude/channel` with `content` (today's mail summary)
  and `meta` (`thread_id`, `message_id`, `from`, `from_name`, `subject`, `sender_verified`,
  attachment links), sent on the session's GET stream with an SSE event id.
- The Durable Object keeps each event until a later reconnect's `Last-Event-ID` shows Metro
  got it (7 days at most), so a dropped stream loses nothing.
- **To prove first**: Cloudflare's `McpAgent` runs on a Durable Object and has the GET stream,
  but its documentation does not show sending from a timer or from another request. A small
  trial decides between it and our own transport on the Durable Object. An open stream also
  keeps the Durable Object awake, which Cloudflare bills by time: measure it, and if it costs
  too much, let the Worker close a quiet stream after a few minutes and Metro reconnect with
  `Last-Event-ID`.
- Tool calls stay stateless POSTs, like SharePoint's; only events need the stream.

## Metro's side (generic, for any remote MCP server that declares `claude/channel`)

1. **Channel connectors.** A connector whose server declares `claude/channel` is a channel:
   given to exactly one agent with a box, with the people who can write and Receive messages on
   its assignment (Postgres), and the sender and chat keys from `metro/channel` (kept with the
   tool list in `connector_tools`), or picked once on the page when a server does not declare
   them. Until Metro knows the sender key, nothing is delivered. This is the connector part of
   step 2 of the channel plan.
2. **mcp.metro.box holds the stream.** For each channel connector, one machine keeps the GET
   stream open with the connector's token (a lease row in Postgres, renewed; the other machine
   takes over when it lapses), and keeps the last delivered event id in Postgres. It never
   stores a message: when the box does not take events, it closes the stream and reconnects
   later from the last delivered id, so mail waits in the Worker.
3. **The gate, on mcp.metro.box.** The sender against the allowlist (today's matching: last
   segment, `@domain`, `*`), `sender_verified="false"` dropped unless the list is `*`, and
   Receive messages Off. Each received message writes its activity row: Delivered or Dropped
   with the reason, never the text or the sender. A dropped event is acknowledged, not retried.
4. **To the box.** The signed long poll the daemon keeps for approvals (`POST /v1/approvals`)
   gets a second kind for events, acknowledged per event id. The daemon turns each one into
   `notifications/claude/channel` for the session, with `source` the connector key and a line
   `metro://<connector key>/<connector id>/<thread id>`, so scope, the replay ring and
   `addressed` work as for any channel. With Pause messages on, the box answers that it is
   paused: the row says "Dropped: messages paused", as nothing is replayed after a pause today.
   This is a new egress: add it to `test/egress-scope-matrix.test.ts`.
5. **Answers.** The agent replies with `tool_call` `gmail.reply` or `outlook.reply`, from a
   worker (the guard keeps `tool_call` off the main thread), which is fine for email. The
   server's `instructions` name the reply tool.
6. **Page.** A channel connector's page adds People (who can write) and Receive messages; Live
   activity shows the received rows next to the calls.

## Moving the mailboxes

- Each mailbox connects again: add `https://mcp.gmail.piston.box/` or
  `https://mcp.outlook.piston.box/` as a connector, sign in, give it to the agent, set People.
- To avoid a mail arriving twice, turn Receive messages Off on the old box channel before the
  new connector goes live, check one mail arrives, then detach the box channel (which deletes
  its token files).
- When no box uses them any more: remove `packages/gmail`, `packages/outlook`, their daemon
  parts, and the managed Gmail code on api.metro.box (its Google client now belongs to the
  Worker).

## Prerequisites (owner)

- **Cloudflare**: the two Workers, their custom domains, KV for OAuth, Durable Objects, an R2
  bucket, two Workers Builds connections.
- **Google**: the Gmail API project, a Pub/Sub topic with publish rights for Gmail's push
  service account, a push subscription with an OIDC token, the Worker's redirect on the OAuth
  client. Public use of `gmail.readonly` needs Google's restricted-scope verification and a
  security assessment, which now covers the Worker, since it stores the tokens.
- **Microsoft**: the new app registration with its secret, publisher verification, and admin
  consent in companies that require it.

## Tests

- **Workers**: stand-in Google and Microsoft endpoints for sign-in, renewals, the push checks
  (OIDC token, validation handshake, `clientState`), cursor reads, duplicates and event replay.
- **Metro**: a stand-in channel MCP server drives mcp.metro.box's stream holder, the gate, the
  relay and the daemon's delivery, over real HTTP.
- **Live**: one test Gmail and one test Outlook mailbox before any real one moves.

## Steps

All of it ships together, built in this order:

1. The Workers: sign-in, the mailbox Durable Object, the tools (usable as plain connectors
   right away).
2. Push and the event stream in the Workers, after the Durable Object trial.
3. Metro: channel connectors, the stream holder, the gate, the relay, delivery on the box, the
   activity rows, the page.
4. Prerequisites and the live tests.
5. The mailboxes move, then the box stations go.

## Open questions

- **Address**: `piston.box` (the repository's pattern) or `metro.box`.
- **Gmail sending**: asked at sign-in, or a second consent as managed Gmail does today.
- **The Durable Object stream**: server-initiated sends and their cost (see Live events).
- **Agents without a server**: they get the tools but no live mail, since nothing receives it.
