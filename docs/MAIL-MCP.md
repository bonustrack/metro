# Gmail and Outlook as connectors (plan, 2026-11-09)

Status: proposal, nothing built.

Gmail and Outlook stop being channels. Each becomes a remote MCP server on Cloudflare Workers,
in the `stagelabs/mcps` repository, that Metro adds like any other connector (Granola,
SharePoint): tools through `tool_search` and `tool_call`, the connector rules and approvals, and
the connector activity log. New mail reaches the agent through a webhook that follows the draft
MCP Events extension, received by mcp.metro.box and passed to the agent's box. Then the `gmail`
and `outlook` stations are removed from Metro. No other channel changes.

## Owner's decisions (Less, 2026-11-08 and 2026-11-09)

- **Only Gmail and Outlook.** They become normal connectors and are removed as channels. The
  other channels stay as they are (`docs/CHANNELS-AS-CONNECTORS.md` is parked beyond its step 1).
- **Not on the box, not in Metro's services**: two Workers in `stagelabs/mcps`, `gmail-mcp` at
  `mcp.gmail.piston.box` and `outlook-mcp` at `mcp.outlook.piston.box`.
- **Gmail signs in only with Metro's Google app**, and asks to read and to send at sign-in.
  Until Google verifies the app, a mailbox outside Metro's own Workspace is a test user and must
  sign in again every 7 days (Google's rule for apps in testing).
- **New mail arrives by push**: Google Pub/Sub and Microsoft Graph notifications.
- **The Workers call Metro with a webhook that follows the draft MCP Events extension**
  (`events/subscribe`, signed POSTs), and **the webhook lands on mcp.metro.box**, which checks it
  and passes the mail to the agent's box.
- **Everything ships together**: the Workers, Metro's webhook side, then the removal of the two
  stations once the mailboxes have moved.
- **Existing mailboxes** may connect again or have their tokens moved; this plan connects them
  again.
- From earlier decisions: the activity log gets a row per tool call and per received mail, never
  its text and never its sender; who may write to the agent is checked by Metro.

## Why a webhook, and why the draft

- MCP 2026-07-28 is stateless: answers come back inside each request, and no standing stream is
  left for a server to push on. The streams of the 2025-11-25 transport would be a dead end.
- MCP's Tasks and Events working group is drafting the standard way for a server to notify a
  client: the "MCP Events" design sketch
  (https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md),
  whose webhook mode is `events/subscribe` with a callback URL and a client-made secret, signed
  POSTs (Standard Webhooks), a TTL refreshed by the client, and a cursor to catch up. Its own
  example event is `email.received`. It is a draft: both ends are ours, so we follow it now and
  move with it.
- Both ends speak the 2025-11-25 protocol the MCP SDKs speak today (an `initialize`, then
  requests). The Events methods are extra JSON-RPC requests on the same endpoint.

## Overview

```
Gmail (Pub/Sub push) / Microsoft Graph (webhook)
        │ "the mailbox changed"
        ▼
gmail-mcp / outlook-mcp Worker ── D1: mailbox tokens (sealed), read position, subscriptions
        │ POST email.received, signed (Standard Webhooks)
        ▼
mcp.metro.box ── checks the signature and the sender, writes the activity row,
        │        keeps the mail sealed until the box takes it
        │ signed long poll (the one approvals use today)
        ▼
the agent's box ── notifications/claude/channel to the session

the agent ── tool_call gmail.reply (from a worker) ──► box ──► mcp.metro.box ──► Worker ──► Gmail
```

## The Workers (`stagelabs/mcps`)

### Shape

- `servers/gmail` and `servers/outlook`, laid out like `servers/sharepoint`
  (`@cloudflare/workers-oauth-provider` for the MCP sign-in, a consent page, the upstream
  sign-in with PKCE, `wrangler.jsonc`, `stage.config.js` entries, Workers Builds). The
  repository's checks apply (`@stage-labs/config`: no comments, strict types, knip, madge).
- What both need (the Events methods, Standard Webhooks signing, sealing, the mail summary,
  HTML to text, the automated-mail filter, the `Authentication-Results` check) lives in one
  shared workspace package of the repository, not copied twice. The mail logic comes from
  Metro's core (`stations/mail`, `mail-text`, `mail-trust`) and the two station packages, copied
  over: the repositories share no package, and the Metro copies are deleted at the end.
- Storage is D1 (one database per Worker). No Durable Object and no open connection: work
  happens when a push, a tool call, an Events call or the hourly Cron Trigger arrives.

### Sign-in

- **Outlook**: a new Microsoft app registration for the Worker (confidential, Web platform,
  redirect `https://mcp.outlook.piston.box/callback`, authority `/common` so Outlook.com works
  too), with today's scopes: `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`,
  `openid`. Not the "Metro Mail" app, whose `https://metro.box/` redirect must stay a
  public-client one (the trap in `CLAUDE.md`).
- **Gmail**: Metro's Google app (today's managed Gmail client), with the redirect
  `https://mcp.gmail.piston.box/callback` added and its id and secret as Worker secrets. Scopes
  `gmail.readonly` and `gmail.send`, both at sign-in.
- **The upstream tokens are sealed in D1** with a Worker secret (AES-GCM, the mailbox id as
  additional data). `workers-oauth-provider` encrypts a grant's `props` with a key only the token
  holder can unwrap, so a push or a Cron run, which have no client token, could not read them
  there. A grant's `props` hold only the mailbox id and address.

### Tools

The verbs of today's stations, each with `readOnlyHint` or `destructiveHint` so Metro's Read and
Write rules apply:

- `send`: a new email to an address (the `subject` argument, else the first line, 255
  characters), or reply-all on a thread when `thread_id` is given; answers the thread id.
- `reply`: answers one message.
- `read`: a thread, a search (`query`, `from`, `since`, `until`, `unread_only`, `limit`), or one
  message in full with its attachments. Outlook marks a message read when it is read in full, as
  today; Gmail never changes the mailbox.
- Attachments: inbound files are stored in an R2 bucket and come back as signed links valid 7
  days; outbound files are an https URL or small inline base64 (Outlook 3 MB each, Gmail 25 MB
  in all), refused before anything is sent.

### Push and reading

A push only says "this mailbox changed": the Worker then reads from its stored position, as the
stations do today, so a repeated or missed push does no harm. The position moves forward only
once Metro has accepted every mail before it (see Delivery), so a failure is read again later.

- **Gmail**: `users.watch` on the Inbox, publishing to a Pub/Sub topic in Metro's Google project
  (Gmail's push service account may publish there), with a push subscription to
  `https://mcp.gmail.piston.box/push` that carries a Google-signed OIDC token, which the Worker
  checks (issuer, audience, the subscription's service account). A watch lasts 7 days; Cron
  renews it every day.
- **Outlook**: a Graph subscription on the Inbox's messages (`created`), plain notifications
  (with message content they last one day and need a certificate), a secret `clientState`, the
  validation handshake, and a lifecycle address for `reauthorizationRequired`, `missed` and
  `subscriptionRemoved`. It lasts at most 10,080 minutes; Cron renews it every day. Graph wants an
  answer within seconds, so the Worker answers first and reads after (`waitUntil`).
- **Cron, hourly**: renewals that are due, and a safety read of every mailbox with a live Events
  subscription, which catches a broken push.
- Automated mail is skipped, and each mail carries `sender_verified`, with today's rules.

### Events (the draft's webhook mode)

- The server declares the draft's `events` capability (under `experimental.events` where the
  SDK types refuse a new top-level capability; Metro accepts both).
- `events/list` answers one event type: `email.received`, `delivery: ["webhook"]`, an empty
  `inputSchema`, and this `payloadSchema` for `data`:
  `{messageId, threadId, from: {address, name?}, to: [address], cc: [address], subject,
  receivedAt, text, senderVerified, attachments: [{name, mime, size, url}]}`. `text` is today's
  mail summary (plain text, quoted history trimmed), at most 32 KB.
- `events/subscribe {name, arguments, delivery: {mode: "webhook", url, secret}, cursor, ttlMs}`
  answers `{id, refreshBefore, cursor, truncated}`. The key is `(principal, url, name,
  arguments)`, the principal is the grant's user, `id` is derived from the key, the secret must
  be `whsec_` plus 24 to 64 random bytes in base64, the URL must be https. Grants: at most a day.
  `events/unsubscribe {name, arguments, delivery: {url}}` ends it.
- Before the first delivery to a URL, the Worker POSTs a signed
  `{"type": "verification", "challenge": "<nonce>"}` and expects the same `challenge` back. The
  Workers also accept `https://mcp.metro.box/v1/events/` as an allowlisted prefix.
- **Delivery**: one POST per mail, `Content-Type: application/json`, body
  `{eventId, name: "email.received", timestamp, data, cursor}`, headers `webhook-id` (the
  `eventId`: the provider's message id), `webhook-timestamp`, `webhook-signature`
  (`v1,` + base64 HMAC-SHA256 of `id.timestamp.body` with the decoded secret) and
  `X-MCP-Subscription-Id`. A 2xx means accepted, 410 means do not retry, anything else is retried
  (4 tries over about 15 minutes), and the position does not move past an unaccepted mail.
- **Cursor**: Gmail's `historyId`, Outlook's delta token. Every delivery carries the safe
  watermark, and a subscribe with a cursor resumes from it, so Metro holds the canonical cursor.

## Metro's side

### mcp.metro.box

1. **Subscriptions.** When a connector's server lists `email.received` with webhook delivery
   (read with its tools, kept in `connector_tools`), mcp.metro.box subscribes once per agent the
   connector is given to, if that agent has a box: callback
   `https://mcp.metro.box/v1/events/<subscription row id>`, a fresh `whsec_` secret sealed with
   `METRO_CONNECTORS_KEY`, the stored cursor, `ttlMs` one day. It refreshes before
   `refreshBefore`, unsubscribes when the connector is unassigned or deleted, and subscribes
   again after a sign-in. One machine does this at a time (a lease row), the other takes over.
2. **The webhook.** `POST /v1/events/<row id>`: verify the signature and the timestamp (5
   minutes), answer a verification challenge, ignore an `eventId` already taken, then apply the
   gate: the sender against the people who can write on that assignment (today's matching: the
   address, `@domain`, `*`), `senderVerified: false` dropped unless the list is `*`, and Receive
   messages Off. A dropped mail writes its row and is accepted. A kept one is stored sealed
   (`METRO_CONNECTORS_KEY`) until the box takes it, at most 7 days, then answered 2xx. Either way
   the cursor is saved.
3. **Activity rows.** Each received mail is one `mcp_calls` row with the connector and the agent,
   outcome Delivered, Dropped with its reason, or Expired, never the text or the sender, counted
   apart from tool calls (their own `kind`), so Calls and the Failed share stay about tool calls.

### The box

- The daemon's signed long poll (`POST /v1/approvals`, `McpServerLink`) also returns waiting
  mail for its agent, and the daemon confirms each one it took, which deletes it.
- Each mail becomes `notifications/claude/channel` for the session, like a chat message today:
  `source` the connector key, a line `metro://<connector key>/<connector id>/<thread id>`, `from`
  as `metro://<connector key>/<connector id>/user/<address>`, `subject`, `sender_verified`, the
  attachment links. Scope, the replay ring and `addressed` treat it like any line of this agent;
  this is a new egress, so it goes into `test/egress-scope-matrix.test.ts`.
- With Pause messages on, the box confirms and drops the mail and mcp.metro.box records
  "Dropped: messages paused", as nothing is replayed after a pause today.
- The agent answers with `tool_call` `gmail.reply` or `outlook.reply`, from a worker (the guard
  keeps `tool_call` off the main thread), which is fine for email. The server's `instructions`
  name the reply tool. Email never carries approvals in chat, as today.

### Postgres (migrated by `apps/api`)

- `connector_agents` gets `senders` (the people who can write, a JSON list, `["*"]` by default
  as for a new mail channel today) and `receive` (Receive messages, default on).
- `connector_subscriptions`: one row per (connector, agent, event): the server's subscription
  id, the sealed secret, the cursor, `refresh_before`, the last error.
- `connector_inbox`: mail waiting for a box, sealed, with its `event_id` (unique per connector),
  deleted once taken, pruned after 7 days.
- `mcp_calls` gets a `kind` (`call` or `received`), with the stats counting calls only.

### The page

- A mail connector's agent page adds People (who can write, `@domain` included) and Receive
  messages, with the summary sentence of a channel. Live activity shows the received rows.
- Add channel no longer offers Gmail or Outlook; it points to the organization's Connectors.

## Removing the two channels

Once the mailboxes have moved:

- Remove `packages/gmail`, `packages/outlook`, their entries in `stations/registry.ts`,
  `stations/attach-browser.ts`, `stations/attach-gmail.ts`, the sign-in return
  (`SignInReturn`, `api/sign-in-return.ts`) where nothing else uses it, the managed Gmail code
  on api.metro.box (`apps/api/src/gmail`, its secrets), the mail code in core that only they
  used, and their parts of `CLAUDE.md`.
- **A box that still has one of them must not break**: at boot the daemon drops a `gmail` or
  `outlook` account from `agent.json` and deletes its state files (the files `forget` removes
  today), with one log line, instead of crashing on an unknown station.
- The page keeps working with an older daemon that still lists them.

## Moving the mailboxes

Each mailbox connects again: add `https://mcp.gmail.piston.box/` or
`https://mcp.outlook.piston.box/` on the organization's Connectors, sign in, give it to the
agent, set People. Turn Receive messages Off on the old channel first, check one mail arrives,
then detach the old channel (which deletes its token files).

## Prerequisites (owner)

- **Cloudflare**: the two Workers and custom domains, KV for OAuth, a D1 database each, an R2
  bucket, two Workers Builds connections, the Workers' secrets.
- **Google**: in the managed Gmail project, the Worker's redirect, a Pub/Sub topic with publish
  rights for `gmail-api-push@system.gserviceaccount.com`, a push subscription with an OIDC token
  to the Worker. Public use needs Google's restricted-scope verification and a security
  assessment, which now covers the Worker.
- **Microsoft**: the new app registration and its secret, publisher verification, admin consent
  where a company requires it.

## Tests

- **Workers**: stand-in Google, Microsoft and webhook endpoints: sign-in, sealing, the tools,
  the push checks (OIDC token, validation handshake, `clientState`), renewals, reading from the
  position, duplicates, the Events methods, signing, verification, retries, and the position
  not moving past a refused mail.
- **Metro**: a stand-in Events server against mcp.metro.box (subscribe, refresh, unsubscribe,
  signature checks, the gate, sealing, the activity rows) and the daemon's delivery to the
  session, over real HTTP; the egress case table.
- **Live**: one test Gmail and one test Outlook mailbox before any real one moves.

## Steps

1. `stagelabs/mcps`: both Workers (one PR).
2. Metro: the Postgres migration, mcp.metro.box's subscriptions and webhook, the box's delivery,
   the activity rows and the page (one PR).
3. Prerequisites and the live tests.
4. The mailboxes move.
5. Metro: remove the two stations (one PR).

## Open questions

- Agents without a server get the mail tools but no live mail, since nothing receives it.
- The Events draft may change; both ends follow it together.
