# Channels as connectors (plan, 2026-11-07)

Status: **step 1 is built** (2026-11-10, see Step 1 below; the rules are in
`docs/rules/TOOL-POLICIES.md`). **The rest is parked** (Less, 2026-11-09: "We should not worry
about other channels"): steps 2 to 8 are a record of the direction, not work in progress.
Gmail and Outlook are handled apart from this plan: they become connectors with events, in a
separate pull request.

A channel (WhatsApp, Telegram, Discord, Gmail, and so on) becomes a connector that can also
receive messages. It is stored, ruled, approved, logged and shown like any connector, and it
pushes its messages to the agent with the standard MCP channel contract. Only two things stay
special: its secret and its session live where it runs, and it belongs to one agent.

## Goal

1. One model. A channel has the same record, rules, approvals, activity log and page as a
   connector, and the agent finds and calls its tools the same way.
2. Any MCP server that pushes live events the standard way can be a channel: our nine
   stations, Anthropic's channel plugins, other people's servers, local (stdio) or remote
   (HTTP).
3. Postgres is the source of truth for everything about a channel except its secret and its
   session files.
4. Nothing breaks on the way: old boxes, the page that ships before them, stored rules, lines.

## Owner's decisions (Less, 2026-11-07)

- **Postgres is the source of truth**, as for connectors and models.
- **Where channel servers run: on the box and remote.** A local server runs on the box,
  started by the daemon. A remote one is added by URL like any connector; mcp.metro.box holds
  its event stream and passes each event to the box of its agent.
- **Secrets of box channels stay on the box.** Postgres holds the record, the rules, the
  people who can write and the approvers. The token, session and database files stay in
  Metro's folder, next to the process that uses them (a WhatsApp session or an XMTP database
  cannot move anyway).
- **Each channel has its own tools** (`whatsapp.send`, `telegram.reply`), like a standard
  channel server. The main thread may call a channel's message tools directly.
- **Our stations are rewritten as standard stdio MCP channel servers**, one at a time. The
  JSON-lines train protocol goes at the end.
- **One allowlist for every channel, checked by Metro.** A channel tells Metro which meta key
  names the sender. Until Metro knows it, nothing from that channel reaches the agent.
- **Chat approvals are checked by Metro on every channel.** Metro posts the question itself
  and reads the `yes <id>` reply as an inbound message, so the approver rule applies. If a
  server hides those replies, approvals for that channel are answered on metro.box only.
- **One agent per channel.** Its events go there and only that agent uses its tools.
- **First step: one rules engine** (see Step 1).
- **Channel activity shows calls and received messages** (2026-11-08): every channel tool call
  is a row, typing included, and every received message is a row with its outcome. No row
  holds a message's text or who sent it.

## The standard

Claude Code's channel contract (https://code.claude.com/docs/en/channels-reference):

- A channel is an MCP server. Claude Code starts it as a subprocess over stdio.
- It declares `capabilities.experimental['claude/channel']: {}` and pushes
  `notifications/claude/channel` with `content` (a string) and `meta` (string values; keys of
  letters, digits and `_` only, others are dropped). Claude sees
  `<channel source="<server name>" key="value">content</channel>`.
- A two-way channel adds a normal MCP tool to answer (`reply`), and its `instructions` tell
  Claude which tool to call and which meta value to pass back.
- The server gates senders itself before it pushes anything.
- `claude/channel/permission: {}` opts in to approval prompts:
  `notifications/claude/channel/permission_request` (`request_id`, `tool_name`,
  `description`, `input_preview`) goes to the server, `notifications/claude/channel/permission`
  (`request_id`, `behavior`) comes back. The verdict does not say who answered.
- The Agent SDK and `claude -p` ignore channels.

Metro already uses this contract between the daemon and the SDK runner: the daemon sends
`notifications/claude/channel` on `/mcp`, and the runner turns it into a user message
(`packages/sdk-runner/src/link.ts`), because the SDK does not. The permission pair is used the
same way. What is not standard today is the hop from a station to the daemon (JSON lines,
`packages/core/src/stations/station-runtime.ts`) and the way the agent calls channel tools.

## What existed on 2026-11-07

Step 1 has since changed the Rules and Ask rows: channels now use the connectors' decision and
the connectors' Ask contract, enforced by the daemon.

| | Channels | Connectors |
|---|---|---|
| Record | `agent.json` on the box (`stations[]`) | Postgres (`connectors`, `connector_agents`) |
| Secret | on the box | sealed in Postgres, never on a box |
| Runs | a train per station on the box | mcp.metro.box calls the vendor |
| Agent's tools | about 23 flat `mcp__metro__*` tools with a `line` | `tool_search` and `tool_call`, `<key>.<tool>` |
| Rules | `policy/policy.ts`, `mcp/policy-gate.ts`, the hook's copy (`hooks/policy.mjs`, `policy.json`) | `@metro-labs/http/connector-policy` |
| Ask | the hook asks Claude Code, the daemon waits for a grant | `needs_approval` with an id, repeated with `approval` |
| Activity | none | `mcp_calls`, Live activity, stats |
| Page | the agent's Channels tab, read from the box | the organization's Connectors, read from api.metro.box |

The rule shape is already the same on both sides (`read`, `write`, `tools`, each allow, ask or
deny). The code that decides it exists three times.

## What cannot change

- **The listener and the secret run together.** XMTP (MLS database, 10 installations),
  WhatsApp (Signal state, bans from cloud addresses) and the Telegram user account allow only
  one process per account. Hosted stations existed once and were removed (`0022_local_only`,
  `docs/HISTORY.md`).
- **The agent never reaches a channel server.** In Claude Code's design, Claude Code starts
  each channel server as the same user. On a box the agent runs as `agent` and the secrets
  belong to `metro`, so the daemon stays in the middle: it is the MCP client of every channel
  server and the MCP server of the runner.
- **Replies stay fast.** A reply must not need a `tool_search` first, and the guard keeps
  `tool_call` off the main thread.
- **The page ships before the boxes.** Every step keeps an older daemon working until every
  box runs the new one.

## Target model

### The record

- A channel is a row in `connectors` with `kind = 'channel'` (every row today becomes
  `kind = 'mcp'`), given to exactly one agent through `connector_agents`.
- It holds what a connector holds (name, key, default rules, the agent's rules) plus: where it
  runs (the box, or a URL), the station for ours, identity facts (bot name, phone, inbox id,
  mailbox), Receive messages (`enabled`), the people who can write and the approvers, and for a
  server we did not write the meta keys of the sender and the chat.
- A box channel has no secret in Postgres. A remote channel has its sealed `secret` like any
  connector.
- **Delivery to the box**: a signed `POST /api/agents/channels` answers this agent's channel
  records, never a secret, like `POST /api/agents/models`. The box fetches it at boot, every
  60 s and when the page asks for a sync. Unlike the model setup, **the last good copy is kept
  on disk** (0600, Metro's folder): the allowlist must still apply after a restart while
  api.metro.box is down. Only a 401 `agent_key_missing` clears it.
- **Import**: each box sends its `agent.json` channels once (signed, idempotent), as the model
  setup moved on 2026-10-15. After that, `agent.json` keeps only what is secret (an account's
  `config`) and the daemon reads everything else from the delivery.
- **Attach stays on the box**, since the secret lands there (QR, pairing code, OAuth return,
  bot token). When an attach completes, the box creates the row with a signed call. A detach
  stops the account on the box and removes its files first, then the row.

### On the box

- The daemon is an MCP host: one MCP client per channel server, over stdio. It reads
  `tools/list`, calls `tools/call` and receives `notifications/claude/channel`.
- **Metro's gate stays in the daemon**, between the channel and the agent, for every channel:
  the allowlist by sender, `sender_verified`, `addressed`, attachments, scope by agent id,
  rules, approvals, the Pause messages switch and the replay ring.
- **A Metro extension** in the server's capabilities, `experimental['metro/channel']`, names
  what the daemon needs: the meta keys of the sender and the chat, the tool and arguments that
  send a message (for approval prompts), and for our stations the facts `Station` declares
  today (attachment mode, approvals, reports status, pair again, profiles). A server without
  it can still be added: the admin picks the sender and chat keys once on the page.
- **Our stations** keep their handlers. `makeStation` and the JSON-lines protocol give way to an
  MCP server per train. Actions the agent never calls (accounts, profiles, sender lookup, call
  signals, attach) become tools the daemon does not publish to the agent.
- The 4 MiB line limit stays: stdio MCP is also one JSON message per line, so no base64 ever
  crosses the pipe.

### Remote channels

- A remote channel is a URL like any connector. mcp.metro.box keeps its GET stream open
  (Streamable HTTP lets a server push notifications on it), one machine per channel through a
  lease row in Postgres so the two machines never relay the same stream.
- Each event goes to the box of the channel's agent over the signed link (the long poll that
  carries approvals today, `POST /v1/approvals`, grows into an events route), and the daemon
  applies the same gate.
- Tool calls go through mcp.metro.box as for any connector. An agent without a server cannot
  have a channel, since it has no session to deliver to.

### What the agent sees

- Each channel is a connector in `tool_search`, with a key like any connector (`whatsapp`,
  `gmail-fabien`) and tools named `<key>.<tool>`.
- **The message tools of the agent's channels are direct tools** of the `metro` server,
  always loaded, allowed on the main thread. A tool name may not hold a dot (the model API
  takes letters, digits, `_` and `-`), so they are `<key>_<tool>` there (`whatsapp_send`).
- The inbound tag names the channel: `<channel source="<key>" …>`, with Metro's own meta (the
  line, the sender, `sender_verified`, `addressed`) next to the server's.
- Until every box has the per-channel tools, the generic `send`, `reply`, `react` and `typing`
  keep working for our stations.

### Rules and approvals

- One rule shape and one decision, `@metro-labs/http/connector-policy`: the organization layer
  (the channel row's default) and the agent layer, the stricter wins, a tool rule beats its
  group, an unknown tool is write.
- **Ask is the connectors' contract everywhere**: the call answers `needs_approval` with a
  5-letter id, the owner answers in chat, on the page or not at all (24 hours, then denied), and
  the agent repeats the same call with `approval: "<id>"`, once, within 10 minutes of the
  answer. The daemon holds the approval of a box channel's call (the call runs there);
  mcp.metro.box holds a remote channel's, as it does for connectors today.
- A chat answer counts only on the line the question went to, from an approver, never when
  the sender is not verified. For a server we did not write, Metro posts the question with the
  send tool the extension names. Metro never sends `claude/channel/permission_request` to such a
  server, and a verdict it pushes on its own is ignored, since it does not say who answered.

### Activity and page

- The daemon reports each channel tool call (tool, outcome, time; never the arguments) with a
  signed call, typing and reactions included. Rows go to `mcp_calls` with the channel's
  connector id, so Live activity and the stats show them like any connector call.
- **Each received message is a row too**: the channel, the outcome and the time, never the
  text and never the sender. The outcome is Delivered, or Dropped with its reason (not on the
  list, not verified, receiving off, messages paused). These rows are counted apart from
  calls (their own direction or outcome class), so Calls and the Failed share stay about tool
  calls. Metro's own notices are not rows. A busy group can write thousands of messages a
  day, so watch the table's growth (about 33 MB per 100,000 rows today).
- The organization's Connectors list shows channels and connectors together. A channel's
  page keeps Tools (the rules), Settings and Activity, and adds People (who can write, Can
  approve) and Connection (live state, Pair again). The agent's Channels tab reads the same
  rows from api.metro.box, so it renders while the box is offline; only the live connection
  state still comes from the box.

## Steps

Each step ships alone and keeps older daemons working.

1. **One rules engine** (box only, no migration). See below.
2. **Channel records in Postgres**: `kind`, the channel columns, the import, the delivery with
   its disk copy, the page reading channels from api.metro.box once a box has imported
   (a version gate for older boxes).
3. **The daemon as an MCP channel host** with the Metro extension, proven with a server we did
   not write (fakechat). Decide the isolation question first (see Open questions).
4. **Our stations rewritten**, one at a time: webhook, Telegram bot, Discord bot, Gmail,
   Outlook, Threema, Telegram, WhatsApp, XMTP last (the single writer).
5. **Per-channel tools for the agent**, the skill and the server instructions updated. The
   generic message tools stay until every box runs this.
6. **Remote channels** through mcp.metro.box.
7. **Channel calls and received messages in the activity log.**
8. **Remove the old paths**: the train protocol, the rules and people in `agent.json`, the
   page's reads of channels from the box.

## Step 1: one rules engine (built 2026-11-10)

The daemon holds an Ask itself, with an id, as mcp.metro.box does for connectors. The binding
rules are in `docs/rules/TOOL-POLICIES.md`; this is the summary.

- `policyGate` decides with `decideTool` of `@metro-labs/http/connector-policy`, the function
  mcp.metro.box calls. A block answers as before. An Ask with no usable `approval` holds a
  request (5 letters, the `PERMISSION_REPLY_RE` alphabet; one waiting per call, reused), posts
  the question to the owner's chat (`relayLine`; the call's chat for a speech send) and answers
  at once with the id. Nothing waits, so the main thread may make the call itself.
- The owner answers in chat (`yes <id>`, same checks as every prompt), on the page
  (`POST /api/approvals/<id>`) or not at all (24 hours, denied). Metro then tells the agent:
  `Approved: <tool> on <station> (<id>). Call <tool> again with the same arguments and
  approval: "<id>".`, `Denied: …` or `Expired: …`.
- The repeated call carries `approval: "<id>"`. It runs once, within 10 minutes of the answer,
  when the approval was given for that tool, exactly those arguments (their digest, the
  `approval` field left out), that channel account and that agent. A speech send also needs
  the same live call, and its approval ends at hang-up. Every gated metro tool's schema has an
  optional `approval` string.
- The rule is decided again on every call: a rule moved to Block wins over an approval, and a
  rule moved to Allow or Block withdraws the question and the unused approval at once, and
  tells an agent that was waiting.
- The rule that applies is the rule of the account that acts: the account of the call's line,
  always, plus an account the call names. Until this step an added `account` argument could
  lift a Block or an Ask.
- The owner can see everything that will run: the chat question shows what matters first,
  never lets an argument write one of its lines, and counts what does not fit in 1,000
  characters with a pointer to metro.box, where the approval card lists every argument.
- A name that is no metro tool is refused before any rule or question.
- An id that cannot be used says why (not known after a restart, another call, used, too old,
  expired, withdrawn) and the owner is asked again. 50 requests wait at most; arguments too
  large to show are refused. Everything is in memory: no file, no stored call.
- **Shared with connectors** (`packages/http`): the decision (`connector-policy`), the digest of
  a call's arguments (`args-digest`), and the id pattern, the 24 hours, the 10 minutes, the 50
  and the `approval` schema property (`approval-rules`).
- **Removed**: the hook's copy of the rules (`packages/cli/hooks/policy.mjs`, its use in
  `guard.mjs`), `policy.json` and `mcp/policy-snapshot.ts` (the agent view removes the agent's
  copy; the one in Metro's folder stays, unread), the grants in `approvals/pending.ts`, and the rule
  that an Ask on the main thread must move to a worker (server instructions and the `metro`
  skill).
- **Kept**: the relay of Claude Code's own prompts (the auto mode classifier, any other tool),
  whose answer never authorizes a metro call, `settlePromptsFor` and the preview reading it
  uses, the page's approval list, chat answers, the expiry, the stored rules and their shape,
  the guard's orchestrator rules.
- **Older pieces**: the hooks ship in the same package as the daemon, so a box never runs a new
  daemon with an old hook. The page needs no change.

## What stays the same

- Lines (`metro://<station>/<account>/…`) and every on-disk and wire name that uses `station`.
- The allowlist rules (last segment, case-insensitive, `@domain`, `*`), approvers as a subset
  of it, `sender_verified`, `PERMISSION_REPLY_RE`.
- Scope by agent id and the egress case table (`test/egress-scope-matrix.test.ts`).
- Never fatal in the relay path, the in-memory bus ring, Pause messages.
- The XMTP single writer, WhatsApp's persisted tokens, the files `forget` removes.
- `.metro` files and the bundle.

## Open questions

- **A local server we did not write runs next to Metro's secrets.** As the `metro` user it
  could read every token. It needs its own system user (no access to Metro's folder) or a
  systemd sandbox, or only a pinned list of servers. Decide before step 3.
- **Lines for a server we did not write**: scope, the owner's chat and approvals are keyed by
  line. Proposal: `metro://<channel key>/<channel id>/<chat>`, built by the daemon from the chat
  meta key.
- **Context cost**: a direct `send` with attachments and frames is a large schema. With several
  channels on one box, measure the always-loaded tools before step 5, and load only `send`,
  `reply` and `react` directly if needed.
- **Trust**: the allowlist and the approvers move to api.metro.box, so whoever controls it can
  change who may write to an agent. The box already trusts Metro's servers with every model
  answer (gateway.metro.box), so this does not widen what it trusts, but it is a new path.
