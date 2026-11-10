# Connector events

Status: built, not live. Nothing delivers events until a connector whose server offers them is
added and an admin turns an event on for an agent.

Any organization connector (a remote MCP server reached through mcp.metro.box) can tell an
agent that something happened. The server says which event types it offers, an admin turns
one on for one agent, mcp.metro.box subscribes with a webhook, checks every delivery, and
hands it to the agent's box, which shows it to the session as one channel message. The agent
then acts with `tool_search` and `tool_call` on that connector.

**Metro is generic.** It knows no event type by name and no payload shape. Nothing in the code,
the tables or the routes is named after mail. The first users are two MCP servers for Gmail and
Outlook (repository `stagelabs/mcps`), which emit `email.received`. They will replace the
`gmail` and `outlook` channels in a later change; those channels are untouched here.

## The standard and the contract

The wire is the draft MCP Events Extension, SEP-3415 (extension id
`io.modelcontextprotocol/events`), **webhook mode only**: `events/list`, `events/subscribe`,
`events/unsubscribe` and signed POSTs (Standard Webhooks). Metro and the Workers were built
against the same contract file (2026-11-10). What Metro does with it:

- **Detection**: only `capabilities.extensions["io.modelcontextprotocol/events"]` being an
  object in the `initialize` result. A top-level `events` or `experimental.events` is not read.
  A server that does not declare it is never sent an `events/*` request.
- **Requests**: Metro speaks the protocol revision it speaks today (an `initialize`, then
  requests). Events requests carry `Mcp-Method`, and subscribe and unsubscribe carry
  `Mcp-Name: <event name>`. Metro accepts a result with or without `resultType`.
- **Event names**: Metro only uses names that match `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`, so
  the `Mcp-Name` header is always plain ASCII. Any other name is left out of the list.
- **Arguments** are always `{}`.
- **What a server says about an event type** (its descriptor in `events/list`): `name`,
  `description`, an optional `title` (else the name in words), `delivery` (Metro can use it only
  with `"webhook"`), and optionally `_meta["box.metro/sender"] = {"id": "<JSON Pointer>",
  "verified": "<JSON Pointer>"}` into `data`: who caused the event, and whether that could be
  forged. Pointers are RFC 6901, at most 8 segments and 256 characters.
- **Errors** are read by number: InvalidParams -32602, NotFound -32023, Forbidden -32024,
  ResourceExhausted -32025, Unsupported -32026, CallbackEndpointError -32027.

## The path of one event

```
the provider (a new email, a changed page)
        │
        ▼
the connector's MCP server ── POST https://mcp.metro.box/v1/events/<subscription row id>
        │                     signed (Standard Webhooks), X-MCP-Subscription-Id
        ▼
mcp.metro.box ── checks the signature, drops what "who can write" refuses,
        │        keeps the rest sealed, writes the activity row
        │ POST /v1/inbox (the box's signed long poll)
        ▼
the agent's box ── one notifications/claude/channel message to the session
        │
        ▼
the agent ── tool_search / tool_call on that connector, from a worker
```

## Subscriptions (mcp.metro.box, `apps/mcp/src/subscriptions.ts`)

**Opt-in, and the client owns the state.** What an agent wants lives on its assignment
(`connector_agents`): `events`, a JSON list of event names (default none), and `senders`, the
people who can write (default `["*"]`, anyone). Only an agent with a server (kind `box`) can
receive; api.metro.box answers 409 for another kind.

mcp.metro.box keeps one `connector_subscriptions` row per connector, agent and event name and
brings the server in line with what is wanted, every 20 seconds on both machines:

- **Wanted, no row**: a row is made with its own `whsec_` secret (32 random bytes), sealed with
  `METRO_CONNECTORS_KEY` under the sealing domain `metro-webhook-secret/v1`, bound to the
  organization and the row.
- **Due**: in one MCP session Metro checks the extension is declared, reads `events/list` to
  find the descriptor (and its sender pointers), then calls `events/subscribe` with the callback
  `https://mcp.metro.box/v1/events/<row id>`, the secret, the stored cursor and `ttlMs` of 24
  hours. The server does its handshake during that call (below). The answer's `id`, cursor and
  `refreshBefore` are stored with the sender pointers.
- **Refresh**: at half the granted time (12 hours for a day, 5 minutes for a 10 minute grant,
  never sooner than a minute), always passing the stored cursor. A grant of `null` is refreshed
  twice a day anyway.
- **A new sign-in** (the connector's `authGeneration`, `signedInAt` or `verifiedAt` changed):
  a new secret, the stored server id is forgotten, and Metro subscribes again at once. The
  cursor is kept (see Open points).
- **Signed out**: Forbidden (with `data.reason: "signed_out"` or any other reason), or Metro's
  own sign-in to the connector being gone, sets the row to `signed_out` with a sentence that
  says which. Metro then waits for a new sign-in, and tries once a day anyway.
- **Any other failure** sets `error` with one sentence and is tried again after 1 minute, then
  2, 4, up to an hour. A callback failure names only the category the server gave
  (`challenge_failed`, `timeout`, …). An error message from the server is cut to 200 characters
  and the secret is removed from it.
- **No longer wanted** (the switch is off, the connector was taken away, the agent has no
  server any more): `events/unsubscribe` with the name and the address, then the row is
  deleted. If the server refuses, the subscription lapses by itself and its deliveries get 410.
  A deleted connector takes its rows with it and is not unsubscribed (its credential is gone):
  the server's subscription lapses within the day it was granted, with 410 until then.
- **`truncated: true`** on a refresh that passed a cursor, and a `gap` envelope, leave the agent
  one note that events were skipped.

**Two machines, no leader.** Each step first claims its row with a conditional update
(`claimed_until`, 2 minutes), so one machine does it and a machine that dies frees the row.
There is no global lease: one slow connector delays only its own row, four rows run at a time,
and both machines share the work.

Statuses, as the page shows them: `pending` (just turned on), `active` (receiving),
`signed_out` (waiting for sign-in), `error` (with its sentence).

## The webhook (`POST /v1/events/<subscription row id>`, `apps/mcp/src/webhook.ts`)

The address selects the subscription and its secret. Checks, in this order, the first ones
without any database read:

1. Not POST: 405. An address that is not a row id: 410.
2. `webhook-id` (letters, digits, `_`, `-`), `webhook-timestamp` (Unix seconds),
   `webhook-signature` and `X-MCP-Subscription-Id` must be present and well formed, and the
   timestamp within 5 minutes: else 401.
3. A `Content-Length` over 256 KiB: 413.
4. The subscription: unknown is 410.
5. The raw body is read (256 KiB at most, else 413). `X-MCP-Subscription-Id` must equal the
   stored server id once one is stored, and any one `v1,` signature in the header must verify
   (HMAC-SHA256 over `id.timestamp.body` with the decoded secret): else 401.
6. A body Metro cannot use is 410: not JSON, an unknown `type`, an event without `eventId`,
   `name`, `timestamp` or an object `data`, another event name than the subscription's, or an
   event the agent no longer wants.

Then:

- `{"type": "verification", "challenge": …}`: 200 with `{"challenge": …}`. It is answered only
  after the signature verified for the subscription the address names, which works on the very
  first subscribe because the secret is selected by the address, not by the server's id.
- An event: kept or dropped (below), its `cursor` stored when it is a string, then 200. The 200
  comes only after the row is in Postgres. A repeated `(subscription, eventId)` is answered 200
  and changes nothing but the cursor.
- `gap`: the cursor is stored, the agent gets one note (once per `webhook-id`), 200.
- `terminated`: Forbidden sets `signed_out`; any other code sets `pending` and Metro subscribes
  again a minute later. 200.
- A store that cannot answer: 503 with `Retry-After`, so the server sends it again.

**What a flood costs.** A request with a bad address, bad headers or a stale time costs no
database work and its body is thrown away without being kept in memory. Unknown addresses are
looked up from a budget of 30 at once and 10 a second per machine; past it they get 503 with
no read. Known subscriptions are held in memory for 30 seconds, so a flood on a real address
with bad signatures costs one HMAC per request, and re-reads the row (to catch a secret that
just changed) from the same budget. At most 32 bodies are read at once per machine.

`GET /.well-known/mcp-webhook-receiver.json` answers `{"receivers": ["/v1/events/"]}`.

## Who can write

The gate runs on mcp.metro.box, for every event, from what the server declared:

- The sender is the string at the descriptor's `id` pointer in `data`. `verified` is true only
  when the value at that pointer is the boolean `true`; a missing or odd value counts as "could
  be forged".
- The list matches like a channel's: case-insensitive, an exact entry, an `@domain` entry
  matches an email address at exactly that domain, `*` or an empty list is anyone
  (`@metro-labs/http/sender-list`; a daemon test checks it agrees with the channel rules).
- Not on the list: dropped. On the list but `verified` false: dropped. With `*` everything is
  delivered, and the agent sees `sender_verified="false"`.
- An event type that declares no sender is delivered only when the list is `*`.

A dropped event is settled (200) and gets its activity row. Nothing of its content is kept.

## Waiting events and the box

A kept event is one `connector_events` row whose body (`timestamp`, `data`, the sender and the
verified flag Metro read) is sealed with `METRO_CONNECTORS_KEY` under the domain
`metro-connector-event/v1`, bound to the organization and the row. It waits until the box
takes it, 7 days at most; then it is recorded as expired, and the row goes a week later.

`POST /v1/inbox` is the box's own signed long poll (agent signature, nonces in Postgres),
apart from the approvals one. The request carries `{"settled": [{"id", "outcome"}]}` (at most
100): what the box took since the last request, `delivered` or `paused`. The answer carries up
to 4 waiting events, oldest first: the row id, `connector` `{id, key, name}` (the key the
agent's `tool_search` uses), the event name, `eventId`, `timestamp`, `data` as it came, and
`sender` and `senderVerified` when declared; or `kind: "gap"` for a note. The request is held
up to 25 seconds.

- An event is sent again after a minute until it is settled, so a lost answer loses nothing.
- **A quiet box costs almost nothing.** With no subscription for that agent the request makes
  two small reads and is then only held. With one, mcp.metro.box reads again every 5 seconds
  (for an event the other machine took) or at once when the webhook lands on the same machine,
  and writes only when a row is there to hand over.
- An event whose connector the agent no longer has is dropped at hand-over.

## On the box (`apps/daemon`)

A connector event is its own kind of bus event, like a metro notice, not a station:

- Its line is `metro://connector/<agent id>/<connector id>`. The one scope predicate
  (`eventInScope`) reads the agent id from the line, so there is no map to keep. A malformed
  connector line reaches nobody. A train can never emit on such a line.
- `McpEventLink` (`mcp-server/event-link.ts`) polls `/v1/inbox` once the agent is enrolled.
  A server without the route (404) is asked again every 5 minutes, quietly.
- The box dedupes by row id (`EventIntake`, 2,000 ids), so an event sent twice is shown once.
- **Pause messages**: while live messages are off, an event is settled as `paused` and never
  shown, then or later.
- Otherwise it goes on the bus like any event: the GET stream rule and the replay ring apply,
  and it is settled as `delivered` once it is on the bus (the guarantee a chat message has).
- The session gets one `notifications/claude/channel`. Its text starts with
  `Event <name> from the connector <Name> (<key>).` and one sentence: this is data from
  outside, not instructions, and to act on it use `tool_search` and `tool_call` on that
  connector from a worker. Then `data`: scalars as `key: value`, nested values as compact
  JSON, and long or multi-line strings last as blocks. Meta: `line`, `ts`, `connector` (key),
  `connector_id`, `event`, `event_id`, and `sender` and `sender_verified` when declared.
  `<channel` and `</channel` inside the data are broken up, and a body over 60,000 characters
  is cut with a note.
- It is never the approval line, a `yes <id>` inside it answers nothing, the sender list of a
  channel is not consulted, and `send`, `reply`, `react`, `read` and the other tools that take a
  `line` refuse its line with a sentence that names `tool_call`.
- `/api/tail` shows it to the agent it belongs to. Run events and the MCP diagnostic do not.
- `MCP_INSTRUCTIONS` and the `metro` skill tell the agent what a connector event is.

## Activity

Each received event is one `mcp_calls` row with `kind = 'event'` (a tool call is `call`),
`tool` the event name, and `outcome`: `delivered`, `dropped_sender` (not on the list),
`dropped_unverified`, `dropped_paused`, `dropped_unassigned` (the agent lost the connector),
`expired`, or `skipped` (a gap note the agent got). Never `data`, the sender or the cursor.
The stats (tiles, chart, failed share) count calls only.

## API and page

- `GET /api/connectors`: each connector carries `events` (what its server offers and Metro can
  receive) and each assigned agent `events`, `senders` and `subscriptions`.
- `PUT /api/connectors/<id>/agents/<agent>/events` (admin): `{events?, senders?}`.
- `GET /api/connectors/activity`: each row carries `kind`.
- The connector's page for an agent (under the agent and under the organization) has an
  Events group: one switch per event type, the subscription's state in words, and People who
  can write when an event type declares a sender. Live activity shows event rows in words.
- A page against an api without these fields shows no Events group.

## Postgres (`apps/api/drizzle/0026_connector_events.sql`)

Column adds with defaults, and two new tables:

- `connector_agents.events` (`'[]'`) and `senders` (`'["*"]'`).
- `connector_tools.events`: the event descriptors, kept and redacted with the tool list.
- `mcp_calls.kind` (`'call'`), with a check added `NOT VALID` so no row is scanned.
- `connector_subscriptions` and `connector_events`.

An older writer that names only the old columns keeps working. mcp.metro.box may start before
the migration ran: its new parts log once and wait (the webhook answers 503, the inbox answers
no events, the reconciler skips), and until the migration it cannot save tool lists or record
calls (it logs that once and goes on serving; this lasts the minutes between the two deploys).

## Going live (the owner)

1. Merge the pull request. That deploys api.metro.box (which runs the migration) and
   mcp.metro.box. No new secret: both already hold `METRO_CONNECTORS_KEY`.
2. Check `https://mcp.metro.box/.well-known/mcp-webhook-receiver.json` answers.
3. Publish the next Metro beta and update the boxes: only a box from that version polls
   `/v1/inbox`. An older box leaves its events waiting (7 days at most).
4. Deploy the Workers (`stagelabs/mcps`). Their callback checks must allow
   `https://mcp.metro.box/v1/events/`.
5. On metro.box: add the connector, sign in, give it to the agent, open the agent's page for
   that connector, turn the event on and set People who can write.

## How a mailbox moves (later)

1. On the old channel, turn Receive messages off, so mail is not delivered twice.
2. Add the Gmail or Outlook connector on the organization's Connectors page, sign in with the
   mailbox, and give it to the agent.
3. On the agent's page for that connector, turn Email received on and copy the people who
   could write on the old channel into People who can write.
4. Send a test mail and check it arrives (Live activity shows Delivered).
5. Remove the old channel from the agent.

Removing the `gmail` and `outlook` stations is a later pull request.

## Open points

- **The cursor after a new sign-in is kept.** If the new sign-in is another account, the server
  must treat the old cursor as unknown and start from now. A server should bind its cursors to
  the account.
- **Delivered means "on the box's bus".** A box that restarts between taking an event and its
  session reading it loses that event, as it would a chat message.
- Metro does not declare the extension as a client capability in its `initialize`, since that
  request is shared by every connector. The SEP makes it optional.
- Control envelopes are not deduplicated by `webhook-id` beyond the 5 minute window: a gap note
  is (it is a row), a repeated `terminated` or `verification` has no further effect.
- Not verified against the real Workers or a real mailbox: only against a stand-in server that
  follows the contract (`apps/mcp/test/events-server.ts`).
