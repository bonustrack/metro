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
  ResourceExhausted -32025 (with `data.limit`, `subscriptions` or `verifications`), Unsupported
  -32026, CallbackEndpointError -32027 (with `data.reason`).

## What Metro expects from a server

Beyond the SEP's own rules, a server works with Metro when:

- `events/list` and `events/subscribe` work in the same MCP session, right after `initialize`,
  with the connector's credential. Metro reads the list before every subscribe.
- The handshake happens inside the `events/subscribe` call and is signed with the secret of
  that call. Metro waits 30 seconds for the call, 90 seconds for the whole step.
- `events/subscribe` carries `ttlMs` (24 hours) and `maxAgeMs` (7 days: Metro keeps nothing
  older, so a resume after weeks should not replay them). A server may ignore `maxAgeMs`. One
  that honours it answers `truncated: true` only when that floor really passed the cursor (the
  SEP's rule), since Metro writes one `skipped` activity row for every `truncated` answer.
- Every POST carries the four headers. `webhook-id` has only letters, digits, `_` and `-` (256
  at most), `X-MCP-Subscription-Id` is at most 128 printable ASCII characters without a space,
  `eventId` at most 512 characters with no control character, a cursor at most 8,192, the body
  at most 256 KiB, `timestamp` a date, `data` an object nested at most 32 levels deep.
- 401 and 503 mean "send it again later" (a 401 can follow a new sign-in, until the server signs
  with the new secret; a 503 means Metro cannot keep the event yet). 410 and 413 mean "never
  again".
- After a new sign-in Metro sends a new secret on its next subscribe. If the sign-in is another
  account, the cursor Metro passes belongs to the old one: the server must treat it as unknown,
  start from now and answer `truncated: true`. **Metro cannot end the old account's
  subscription**: by the time mcp.metro.box sees the new sign-in, api.metro.box has replaced the
  credential, so no request can be made as the old account. Its deliveries get 401 until it
  lapses (a day at most). A server should end the other account's subscription when a subscribe
  arrives for the same callback address.
- `events/unsubscribe` is called with `{name, arguments: {}, delivery: {url}}`.

## The path of one event

```
the provider (a new email, a changed page)
        │
        ▼
the connector's MCP server ── POST https://mcp.metro.box/v1/events/<subscription row id>
        │                     signed (Standard Webhooks)
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
(`connector_agents`): `events`, a JSON list of event names (default none), and `senders`, who
can write (default `["*"]`, anyone). Only an agent with a server (kind `box`) can receive;
api.metro.box answers 409 for another kind.

mcp.metro.box keeps one `connector_subscriptions` row per connector, agent and event name and
brings the server in line with what is wanted, every 20 seconds on both machines:

- **Wanted, no row**: a row is made with its own `whsec_` secret (32 random bytes), sealed with
  `METRO_CONNECTORS_KEY` under the sealing domain `metro-webhook-secret/v1`, bound to the
  organization and the row.
- **Due** (`next_at` passed, or the sign-in changed): in one MCP session Metro checks the
  extension is declared, reads `events/list` to find the descriptor (and its sender pointers),
  then calls `events/subscribe` with the callback `https://mcp.metro.box/v1/events/<row id>`,
  the secret, the stored cursor, `ttlMs` and `maxAgeMs`. The server does its handshake during
  that call (below). The sender pointers are stored (`sender`, which also marks the row as
  subscribed once), and `next_at` is set from `refreshBefore`. **The answer's cursor is stored
  only when the stored cursor is still the one Metro sent**, so a delivery that landed during
  the call is never put back.
- **Refresh**: at half the granted time (12 hours for a day, 5 minutes for a 10 minute grant,
  never sooner than a minute), always passing the stored cursor. A grant of `null` is refreshed
  twice a day anyway.
- **A new sign-in** (the connector's `authGeneration`, `signedInAt` or `verifiedAt` changed):
  a new secret is written with the row made due at once, and Metro subscribes again. A machine
  that stops right after writing the secret leaves a row that is still due. The cursor is kept
  (see Open points).
- **Signed out**: Forbidden (with `data.reason: "signed_out"` or any other reason), or Metro's
  own sign-in to the connector being gone, sets the row to `signed_out` with a sentence that
  says which. Metro then waits for a new sign-in, and tries once a day anyway.
- **Any other failure** sets `error` with one sentence and is tried again after 1 minute, then
  2, 4, up to an hour. A callback failure names only the category the server gave
  (`challenge_failed`, `timeout`, …), ResourceExhausted says which limit, and any other error
  message from the server is cut to 200 characters with the secret removed. Only the call to
  the server is judged this way: a failure of Metro's own write afterwards is logged and the
  row is simply tried again.
- **No longer wanted** (the switch is off, the connector was taken away, the agent has no
  server any more): `events/unsubscribe` with the name and the address when the row was ever
  subscribed, then the row is deleted. If the server refuses, the subscription lapses by itself
  and its deliveries get 410. A deleted connector takes its rows with it and is not
  unsubscribed (its credential is gone): the server's subscription lapses within the day it was
  granted, with 410 until then.
- **Skipped events** (`truncated: true` on a subscribe that passed a cursor, or a `gap`
  envelope): the new cursor is stored, one line is logged and one `skipped` activity row is
  written. The agent is not told: it would learn nothing it can act on.

**Two machines, no leader.** Each step first claims its row with a conditional update
(`claimed_until`, 2 minutes), so one machine does it and a machine that dies frees the row.
There is no global lease. Four rows run at a time per machine and one step has 90 seconds in
all, under the claim time, so a slow server holds one of the four lanes for 90 seconds at most
per row, and its failures back off.

Statuses, as the page shows them: `pending` (just turned on), `active` (receiving),
`signed_out` (waiting for sign-in), `error` (with its sentence).

## The webhook (`POST /v1/events/<subscription row id>`, `apps/mcp/src/webhook.ts`)

The address selects the subscription and its secret. Checks, in this order, the first ones
without any database read:

1. Not POST: 405. An address that is not a row id: 410.
2. `webhook-id` (letters, digits, `_`, `-`), `webhook-timestamp` (Unix seconds),
   `webhook-signature` and `X-MCP-Subscription-Id` must be present and well formed, and the
   timestamp within 5 minutes: else 401. **The value of `X-MCP-Subscription-Id` is not compared
   with anything**: the address already selects the row and its secret, and the header is not
   covered by the signature.
3. A `Content-Length` over 256 KiB: 413.
4. The subscription: unknown is 410.
5. The raw body is read: 256 KiB at most (else 413), 5 seconds at most, and **4 bodies at once
   per address** (128 per machine), else 503. So requests without the secret can only fill the
   slots of the address they name.
6. Any one `v1,` signature in the header must verify (HMAC-SHA256 over
   `id.timestamp.body` with the decoded secret, the timestamp as the header wrote it): else
   401, logged once a minute at most.
7. A body Metro cannot use is 410: not JSON, an unknown `type`, an event without `eventId`,
   `name`, `timestamp` or an object `data`, an `eventId` with a control character, `data` nested
   deeper than 32 levels, another event name than the subscription's, or an event the agent no
   longer wants.

Then:

- `{"type": "verification", "challenge": …}`: 200 with `{"challenge": …}`. It is answered only
  after the signature verified for the subscription the address names, which works on the very
  first subscribe because the secret is selected by the address.
- An event: **503 until the first subscribe answer is recorded** (before that Metro does not
  know the sender pointers, so it could not judge who wrote), and 503 while 1,000 events
  already wait for that agent. Otherwise it is kept or dropped (below), its `cursor` stored
  when it is a string, then 200. The 200 comes only after the row is in Postgres. A repeated
  `(subscription, eventId)` is answered 200 and changes nothing but the cursor.
- `gap`: the cursor is stored, one `skipped` activity row, 200.
- `terminated`: Forbidden sets `signed_out`; any other code sets `pending` and Metro subscribes
  again after a minute (longer after repeated failures). 200.
- A store that cannot answer: 503 with `Retry-After`, so the server sends it again.

**What a flood costs.** A request with a bad address, bad headers or a stale time costs no
database work and its body is thrown away without being kept in memory. Unknown addresses are
looked up from a budget of 30 at once and 10 a second per machine; past it they get 503 with
no read. Known subscriptions are held in memory for 30 seconds, so a flood on a real address
with bad signatures costs one HMAC per request, re-reads the row (to catch a secret that just
changed) from the same budget, and holds at most the 4 body slots of that address.

`GET /.well-known/mcp-webhook-receiver.json` answers `{"receivers": ["/v1/events/"]}`.

## Who can write

The gate runs on mcp.metro.box, for every event, from what the server declared:

- The sender is the string at the descriptor's `id` pointer in `data` (320 characters at most,
  no control character, else it counts as no sender). `verified` is true only when the value at
  that pointer is the boolean `true`; a missing or odd value counts as "could be forged".
- The list matches like a channel's, with the same code (`@metro-labs/http/sender-list`, which
  the daemon's channel allowlist uses too): case-insensitive, an exact entry, an `@domain` entry
  matches an email address at exactly that domain, `*` or an empty list is anyone. **A stored
  list that cannot be read lets nobody write**, and the api answers it as `[]`, which the page
  shows as nobody.
- Not on the list: dropped. On the list but `verified` false: dropped. With `*` everything is
  delivered, and the agent sees `sender_verified="false"`.
- An event type that declares no sender is delivered only when the list is `*`.

A dropped event is settled (200) and gets its activity row. Nothing of its content is kept:
its `connector_events` row holds only the ids, so the same event sent again is a duplicate.

## Waiting events and the box

A kept event is one `connector_events` row whose body (`timestamp`, `data`, the sender and the
verified flag Metro read) is sealed with `METRO_CONNECTORS_KEY` under the domain
`metro-connector-event/v1`, bound to the organization and the row. **A row waits while its body
is set**; settling it empties the body. Rows are numbered as they are written (`seq`), and that
is the order the box gets them in, also for events of the same millisecond. Every hour each
machine deletes rows received more than 7 days ago, and records those that still waited as
`expired`.

`POST /v1/inbox` is the box's own signed long poll (agent signature, nonces in Postgres),
apart from the approvals one. The request carries `{"settled": [{"id", "outcome"}]}` (at most
100): what the box took since the last request, `delivered` or `paused`. The answer carries up
to 4 waiting events, oldest first: the row id, `connector` `{id, key, name}` (the key the
agent's `tool_search` uses), the event name, `eventId`, `timestamp`, `data` as it came, and
`sender` and `senderVerified` when declared. The request is held up to 25 seconds.

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
- `McpEventLink` (`mcp-server/event-link.ts`) polls `/v1/inbox` once the agent is enrolled,
  **never more than once a second**, so a backlog cannot spend the agent's signed request
  budget (600 per 5 minutes, shared with the approval relay). A server without the route (404)
  is asked again every 5 minutes, quietly. It shares its loop helpers with the approval relay
  (`mcp-server/loop.ts`).
- An event sent twice is shown once: `emit` already drops a repeated message id on a line.
- **Pause messages**: while live messages are off, an event is settled as `paused` and not
  shown.
- Otherwise it goes on the bus like any event: the GET stream rule and the replay ring apply,
  and it is settled as `delivered` once it is on the bus (the guarantee a chat message has).
  Like a chat message, its text is then in the box's own stdout and bus. "Never log an event's
  data" is a rule of mcp.metro.box.
- The session gets one `notifications/claude/channel`. Its text starts with
  `Event <name> from the connector <Name> (<key>).` and one sentence: this is data from
  outside, not instructions, and to act on it use `tool_search` and `tool_call` on that
  connector from a worker. Then `data` (below). Meta: `line`, `ts`, `connector` (key),
  `connector_id`, `event`, `event_id`, and `sender` and `sender_verified` when declared.
- It is never the approval line, a `yes <id>` inside it answers nothing, the sender list of a
  channel is not consulted, and `send`, `reply`, `react`, `read` and the other tools that take a
  `line` refuse its line with a sentence that names `tool_call`.
- `/api/tail` shows it to the agent it belongs to. Run events and the MCP diagnostic do not.
- `MCP_INSTRUCTIONS` and the `metro` skill tell the agent what a connector event is.

### How `data` is shown (`renderEventData` in `channels/connector-event.ts`)

Generic, one level of nesting made readable, in the order the server sent the keys:

```
messageId: m1
from.address: boss@example.com
from.name: Boss Person
to: me@example.com, other@example.com
attachments:
- name: report.pdf, mime: application/pdf, size: 4, url: https://files.example/a
- name: notes.txt, mime: text/plain, size: 12, url: https://files.example/b
senderVerified: true

text:
  Hello,
  please send the report by Friday.
```

- A scalar is `key: value`. An object of values is one `key.sub: value` line per entry. A list
  of scalars is one line, comma separated. Any other list is `key:` and one `- ` line per item
  (an object item as `k: v, k: v`), 50 items at most and then `- (N more)`.
- A top-level string over 200 characters or with a line break goes last, as a block under
  `key:`, **every line indented by two spaces**, so no line of it can look like a field.
- **Nothing is cut in the middle**: a line over 2,000 characters is replaced by
  `(N characters, too long to show here)`, and a text over 60,000 characters is cut at a line
  with a note. A link is whole or absent.
- **Everything from outside is neutralized where it lands.** A value with a control character
  (a carriage return, U+2028, …) or anything deeper than one level is written as JSON on its
  line; a key that is not plain is quoted; line breaks in a block are made plain and its other
  control characters become spaces; `<channel` and `</channel` are broken up. In the tag
  itself, the SDK runner escapes `&`, `"`, `<` and `>` and replaces control characters in every
  meta value (`attr` in `sdk-runner/src/channel-text.ts`, for chat messages too).

## Activity

Each received event is one `mcp_calls` row with `kind = 'event'` (a tool call is `call`),
`tool` the event name, and `outcome`: `delivered`, `dropped_sender` (not on the list),
`dropped_unverified`, `dropped_paused`, `dropped_unassigned` (the agent lost the connector),
`expired`, or `skipped` (the server skipped events it could no longer read). Never `data`, the
sender or the cursor. The stats (tiles, chart, failed share) count calls only.

A database error in these paths is logged as its code and message only (`failureText` in
`@metro-labs/connectors/db/errors`), since the driver's own text holds the statement's
parameters: a cursor, an event id, a sealed body.

## API and page

- `GET /api/connectors`: each connector carries `events` (what its server offers and Metro can
  receive) and each assigned agent `events`, `senders` and `subscriptions`.
- `PUT /api/connectors/<id>/agents/<agent>/events` (admin): `{events?, senders?}`.
- `GET /api/connectors/activity`: each row carries `kind`.
- The connector's page for an agent (under the agent and under the organization) has an
  Events group: one switch per event type, the subscription's state in words, and Who can
  write when an event type declares a sender. Who can write is the channel's own editor
  (`chats/WhoCanWrite.tsx`), without the Can approve column. The group is a skeleton until the
  agent's Metro version is known, so its note never changes after it shows. Live activity shows
  event rows in words.
- A page against an api without these fields shows no Events group.

## Postgres (`apps/api/drizzle/0026_connector_events.sql`)

Column adds with defaults, and two new tables:

- `connector_agents.events` (`'[]'`) and `senders` (`'["*"]'`).
- `connector_tools.events`: the event descriptors, kept and redacted with the tool list.
- `mcp_calls.kind` (`'call'`), with a check added `NOT VALID` so no row is scanned.
- `connector_subscriptions`: `id`, `owner`, `connector`, `agent`, `event`, the sealed `secret`,
  `cursor`, `sender` (the pointers, set by the first subscribe), `status`, `error`, `failures`,
  `signed_in` (the sign-in it was made for), `next_at`, `claimed_until`.
- `connector_events`: `id`, `seq`, `owner`, `connector`, `agent`, `subscription`, `event`,
  `event_id`, the sealed `body` (null once settled or dropped), `received_at`, `delivered_at`.

An older writer that names only the old columns keeps working. **mcp.metro.box may start before
the migration ran** (the merge deploys both, a known exception to "the migration ships first"):
its new parts log once and wait (the webhook answers 503, the inbox answers no events, the
reconciler skips), and until the migration it cannot save tool lists or record calls (it logs
that once and goes on serving `tool_search` and `tool_call`). This lasts the minutes between the
two deploys, or until the api deploy is fixed if it fails.

## Going live (the owner)

1. Merge the pull request. That deploys api.metro.box (which runs the migration) and
   mcp.metro.box. No new secret: both already hold `METRO_CONNECTORS_KEY`.
2. Check `https://mcp.metro.box/.well-known/mcp-webhook-receiver.json` answers.
3. Publish the next Metro beta and update the boxes: only a box from that version polls
   `/v1/inbox`. An older box leaves its events waiting (7 days at most).
4. Deploy the Workers (`stagelabs/mcps`). Their callback checks must allow
   `https://mcp.metro.box/v1/events/`.
5. On metro.box: add the connector, sign in, give it to the agent, open the agent's page for
   that connector, turn the event on and set Who can write.

## How a mailbox moves (2026-11-11)

An admin moves a Gmail or Outlook channel from its own page: Move to a connector, in the
channel's menu and in the note at the top of the page. It opens a guided page
(`#/<agent>/channel/<account>/move`, rules in `docs/rules/APP.md`). **The sign-in is not
moved** (owner's decision, 2026-11-09): the channel's tokens belong to other OAuth apps and
never leave the box, so the mailbox signs in again. Everything else is done by the page, with
the existing APIs of api.metro.box and of the box. This is the one place where the page knows
mail: Metro's services stay generic.

1. **Connector.** One connector per mailbox, at the provider's server address
   (`https://mcp.gmail.piston.box/` or `https://mcp.outlook.piston.box/`, one constant per
   provider in `apps/app/src/lib/mail-move.ts`; `EXPO_PUBLIC_METRO_GMAIL_MCP_URL` and
   `EXPO_PUBLIC_METRO_OUTLOOK_MCP_URL` replace them in a test build). A connector at that
   address that is signed in to the mailbox is reused, whatever its name. Else the one named
   after the mailbox is reused. Else one is made, named after the mailbox.
2. **Sign in**, with the connector's own OAuth sign-in. Then the page checks the mailbox (below)
   and refuses to go on when the connector is signed in to another one.
3. **Settings**, shown before anything is written: the connector is given to the agent; the
   channel's people who can write become the assignment's list (addresses and `@domain` in
   lower case, `*` stays anyone; an entry that is neither is left out and named; a list with
   nothing left cannot be stored, so Email received then stays off); the channel's Allow, Ask
   and Block rules become the agent's rules for the connector, tool by tool (`send`, `reply`
   and `read` keep their rule; `list_members` and `list_channels` have no twin, so `read`, which
   does their job, takes the strictest of the three); `email.received` is turned on when the
   channel received messages. **Never looser than the channel**: the stricter of the channel's
   rule, a rule the agent already has for the connector and the organization's rule applies,
   and the page says which one made a rule stricter. Not carried over, and said so: approvers
   (email never had them), mail the connector skips as automated (`includeAutomated`), and past
   conversations, which stay on the channel's page.
4. **The switch.** The order that cannot lose a mail: who can write is set, then
   `email.received` is turned on while the channel still receives, the page waits until the
   subscription is `active` (the server delivers mail from that moment on), then for one more
   minute (`MOVE_OVERLAP_MS`, two of the channel's 30 second polls, so the channel delivers
   what arrived before that moment), and only then turns the channel's Receive messages off. A
   mail that arrives in that minute reaches the agent twice, once on each path; the page says
   so. The other order (channel off first) loses every mail until the subscription starts.
5. **Finish.** The page shows that the connector receives, then offers to remove the old
   channel (the box's detach, behind the typed confirmation) or to keep it switched off.

**It goes on from the real state.** The page keeps nothing of its own: the next step is decided
from the connector (there or not, signed in or not, to which mailbox), the assignment, the
event and its subscription, and the channel's switch (`moveStep` in the client's
`api/mail-move.ts`). Closing the page and opening it again continues there. If it is closed
while both paths receive, the channel's page says in red that mail arrives twice, and the move
page asks to switch the old channel off (it waits its minute again). A step that fails says
which one, what stays in place, and that pressing the button again goes on from there.

**Which mailbox a connector is signed in to.** `GET /api/connectors/<id>/tools` reads the
server's `initialize` answer and passes on two things, with credentials withheld like a tool
description: `account`, the string a server declares as
`capabilities.extensions["box.metro/account"] = {"id": "<who this sign-in is>"}`, and
`instructions`. The page takes `account` when it is an address, else the one email address the
instructions name (the mail servers write `This server is the Gmail mailbox <address>.`), else
it does not know, and asks the admin to confirm the mailbox by hand. Neither is stored. **The
mail servers do not declare `box.metro/account` yet**: until they do, the check rests on that
sentence.

Limits: a channel whose poll interval was raised above 30 seconds (`METRO_GMAIL_POLL_MS`,
`METRO_OUTLOOK_POLL_MS`) needs a longer overlap than the page gives; a connector that was
renamed and signed out cannot be recognized, so a second one is made for its mailbox; and the
note on the channel's page finds a move only through a connector named after the mailbox.

Removing the `gmail` and `outlook` stations is a later pull request.

## Open points

- **The cursor after a new sign-in is kept.** If the new sign-in is another account, the server
  must treat the old cursor as unknown and start from now. A server should bind its cursors to
  the account.
- **Delivered means "on the box's bus".** The box takes and settles events while no session is
  attached, so a daemon restart, or more than 500 events before a session reads them, loses
  them, as it would chat messages. A box that stops between publishing and its next request
  shows up to 4 events twice after the restart. A cheap gain later: take nothing while no
  stream is attached.
- **Every received event is one activity row kept for good**, dropped ones included, so a
  mailbox that gets a lot of mail from people not on the list fills Live activity with
  "Dropped: not on the list". Counting them instead is a later change.
- Metro does not declare the extension as a client capability in its `initialize`, since that
  request is shared by every connector. The SEP makes it optional.
- Control envelopes are not deduplicated by `webhook-id`: a repeated `gap` writes one more
  activity row, a repeated `terminated` or `verification` has no further effect.
- Not verified against a real mailbox or the real Workers runtime: against a stand-in server
  that follows the contract (`apps/mcp/test/events-server.ts`), and against the mail servers'
  own code in one process (the interop run, outside this repository).
