# mcp.metro.box

`apps/mcp` (package `@metro-labs/mcp`, Fly app `metro-mcp`, `https://mcp.metro.box`)
is the one MCP endpoint for every agent's connectors, reached through the agent's daemon, or
directly with an access key by an agent that has no server (see Agents without a server). It is its own app with its own
deploy, so a change to api.metro.box, the page or the daemon never redeploys it. Later it
will also serve memory.

## Why

Before (until 2026-10-14), each box received its connectors' credentials from
api.metro.box, kept them in memory, and published every connector to Claude Code as its own
MCP server: ten connectors meant ten servers and hundreds of tool definitions, and
credentials travelled to every box.

Now:

- The agent reaches every connector through two tools of its daemon's `metro` MCP server:
  `tool_search` (the design of Claude Code's `ToolSearch`) finds tools and loads their
  definitions, and `tool_call` runs them. Definitions load only when asked for.
- The daemon forwards both to `https://mcp.metro.box` with the agent's MCP token, which never
  leaves Metro's folder on the box.
- Every connector call runs from mcp.metro.box. Credentials never leave Metro's servers.
- The endpoint stays a plain MCP server: any MCP client holding a token can use it.

Claude Code has one Metro server, `metro` (the daemon on the box: chats, channels, sending
messages, and the two connector tools). Claude Code names the connector tools
`mcp__metro__tool_search` and `mcp__metro__tool_call`.

## The agent's view

mcp.metro.box is Streamable HTTP at `/` (also `/mcp`), JSON answers, no session state. Every
request carries `Authorization: Bearer <MCP token>`, or `Authorization: Bearer <access key>`
for an agent without a server. The daemon's `metro` server publishes
the same two tools with the same schemas, descriptions and annotations (one source,
`packages/http/src/mcp-server-tools.ts`), and passes each call and its result through.

### `tool_search`

- Input: `{ query: string, max_results?: number }` (default 5, at most 20).
- Query forms, as `ToolSearch`:
  - `select:notion.search,linear.create_issue` returns those exact tools.
  - Keywords (`notion create page`) rank tools by how well their name and description match.
  - `+linear issue` requires `linear` in the tool name and ranks the rest by the other words.
- Output: one text block in the `ToolSearch` encoding, then one line showing how to run
  them:

  ```
  <functions>
  <function>{"name":"notion.search","description":"…","parameters":{…JSON schema…}}</function>
  </functions>
  Call these with tool_call: {"calls":[{"tool":"notion.search","arguments":{…}}]}
  ```

  No match answers `No tool matched "<query>".`, names the agent's connectors and suggests a
  broader query or `select:` with an exact name.
- The tool's description (from `tools/list`) names the agent's connectors. The daemon reads
  it at start, every 5 minutes and after it registers the token, and tells the session with
  `notifications/tools/list_changed` when it changes.
- Tools the owner blocked are never returned.

### `tool_call`

- Input: `{ calls: [{ tool: "notion.search", arguments: { … }, approval?: "abcde" }] }`, 1 to
  10 independent calls, run in parallel, answered in order. A malformed input answers with
  the expected shape: `{"calls":[{"tool":"notion.search","arguments":{"query":"roadmap"}}]}`.
- Output: for each call, a text header `[1] notion.search` followed by the vendor's content
  blocks as they came (text, images, resources), or one line saying why it did not run
  (`not_found`, `needs_approval`, `denied`, `blocked`, `signin`, `unavailable`,
  `vendor_error`). The result is an error only when every call failed.
- An unknown connector or tool answers `not_found` with up to 3 of the closest tool names
  and "Run tool_search first."
- A tool name is `<connector key>.<tool>`. The key is the connector's name as a slug
  (`n8n-anderra`), with a short suffix only when two connectors assigned to the same agent
  share a slug. Keys are stable while the agent's assignments do not change.

## Permissions and approvals

Allow / Ask / Block per connector, for Read, Write and each tool, at the organization and
the agent level (the stricter wins). Read means the vendor marked the tool read-only;
anything else is Write. mcp.metro.box reads the policies from the database on every call.
The daemon applies no station policy to the two tools.

- **Block**: hidden from `tool_search`; `tool_call` answers
  `Blocked by the owner's policy for <connector> (<tool>).`
- **Ask**: the first call answers `needs_approval` with a 5-letter id and a sentence for the
  agent. mcp.metro.box records the request (tool, a digest of the arguments, a short
  preview) and hands it to the agent's daemon, which asks the owner exactly as today: a
  chat message (`Approval needed: notion.update_page`, the arguments, then
  `Reply "yes <id>" or "no <id>"`) on the agent's last chat line, and the page's
  approvals list. The owner's answer goes back to mcp.metro.box, and the daemon tells the
  agent in its channel (`Approved: notion.update_page (abcde)` or `Denied: …`). The agent
  then calls `tool_call` again with the same tool and arguments and `approval: "abcde"`.
  An approval works once, for exactly that tool and those arguments, within 10 minutes of
  the answer. Unanswered requests expire after 24 hours (denied). Answered, used and
  expired requests are deleted 7 days after their last change (the answer, else the
  request); a pending one is never deleted before it expired.
- The agent can never approve its own call: answers come only from the daemon's signed
  requests (the enrollment signing key lives in Metro's folder, which the agent user cannot
  read) after an allowlisted approver answered in chat, or from the page.
- `tool_call` is a worker tool: the orchestrator guard denies it on the main thread, as it
  denied every connector tool before. `tool_search` is allowed everywhere.

## The MCP token

- 32 random bytes, `mcp_<base64url>`. The daemon creates it when the agent is enrolled (or
  when it has none), sends only its SHA-256 to mcp.metro.box with a signed request, and
  keeps the token in Metro's own folder (`<agents dir>/mcp-token`, 0600, the metro user's).
- The daemon sends it as `Authorization: Bearer <token>` on each forwarded `tools/call` and
  `tools/list`. The agent user never sees it: the agent view does not carry it, and a copy
  an older daemon put there is removed. A 401 makes the daemon register the token again.
- Enrolling again replaces it. A token whose agent left its organization stops working at
  once.

## Agents without a server

Since 2026-10-23 an agent row may have no server (`agents.kind = 'remote'`, no `host`): an
organization admin creates one on metro.box (Agents, New agent, Without a server) only to
give a person's own Claude Code, or any MCP client, the organization's connectors.

- **Access keys** (`agent_tokens`): an admin creates a key on the agent's Access keys tab
  (`POST /api/agents/<id>/tokens {label}` on api.metro.box). The key is `mcp_` plus 32
  random bytes in base64url, the shape of an MCP token, answered once; only its SHA-256 is
  stored. At most 20 live keys per agent; Revoke (`DELETE …/tokens/<id>`) keeps the row with
  its `revoked_at`. Claude Code:
  `claude mcp add --transport http metro https://mcp.metro.box/mcp --header "Authorization: Bearer <key>"`.
- **Authentication**: a bearer is looked up first as a box's MCP token
  (`agent_keys.mcp_token_hash`), then as an access key that is not revoked, of an agent row
  still in the key's organization. Deleting the agent deletes its keys; moving it to another
  organization drops them. The key's `last_used_at` is written at most once a minute per key
  (in memory per machine), never awaited, with one logged failure. Before api.metro.box ran
  migration `0019` the `agent_tokens` table is missing: boxes work, every access key is a 401,
  and that is logged once.
- **Everything else is the same**: assignments, policies, `tool_search`, `tool_call`, the
  `mcp_approvals` rows and the `mcp_calls` activity. Only the words differ: `initialize`
  answers instructions without the worker rule, and the `needs_approval` line of
  `tool_call` and of a result says the owner approves it on the agent's page on metro.box.
- **Ask is answered on metro.box** (Less, 2026-10-23: the agent has no chat): no daemon
  relays the request, so the page shows it as an approval card on the agent's page
  (`GET /api/agents/<id>/approvals`, members) and an admin answers it
  (`POST /api/agents/<id>/approvals/<approval id> {decision}`). The answer moves the row to
  `allow` or `deny` exactly as `/v1/approvals/answer` does (same 24 hour expiry, same single
  use within 10 minutes). Nobody tells the agent: the person repeats the call, or asks the
  agent to, with `approval: "<id>"`. These routes refuse an agent with a server (409), whose
  approvals its daemon keeps.

## The daemon's view

Requests are signed with the agent's enrollment key (`MetroAgent` scheme,
`packages/http/agent-signature`), like its enrollment requests to api.metro.box. Shapes,
limits and validators live in `packages/http/src/mcp-server-protocol.ts`.

| Request | Body | Answer |
| --- | --- | --- |
| `POST /v1/token` | `{ tokenHash }` | `{ ok: true }` |
| `POST /v1/approvals` | `{}` | `{ approvals: [{ id, connector, tool, preview, requestedAt }] }`, held up to 25 s while there is none |
| `POST /v1/approvals/answer` | `{ id, decision: "allow" \| "deny" }` | `{ ok: true }`, 404 for an unknown or already answered id |

The daemon keeps one `/v1/approvals` request open at a time, merges what it receives into
its pending approvals (chat prompt, page list, 24 h expiry), and sends each answer back.
The server sends a pending approval again every minute, so the daemon keeps the ids it
already posted in chat (`<agents dir>/mcp-approvals.json`, a day at most): after a restart
it holds such an approval again on the chat it was posted to, without posting it twice.

The daemon also forwards the agent's `tool_search` and `tool_call` as JSON-RPC `tools/call`
to `<url>/` with the MCP token (120 s per call), returns the server's `result` as it came,
and answers a tool error itself when the agent is not enrolled ("Connectors are not set up
on this agent") or the server cannot be reached ("mcp.metro.box is unavailable, try
again."). It never logs arguments, results or the token.

The daemon talks to `https://mcp.metro.box` unless `METRO_MCP_SERVER_URL` names another
url (https, or http on this machine only); an empty value turns the client off.

## Inside mcp.metro.box

- Reads connectors, assignments, policies, agent keys and access keys from api.metro.box's
  Postgres (the same database; migrations still run from `apps/api` only). Its own tables:
  the token hash on the agent key row, `mcp_approvals` and `mcp_calls`; it writes only
  `last_used_at` of `agent_tokens`, which api.metro.box owns.
- Opens a connector's credential with `METRO_CONNECTORS_KEY`, refreshes OAuth tokens (single
  flight, the same rules and uncertainty records as api.metro.box), and calls the vendor
  through the same safe egress (HTTPS only, no redirects, no private addresses, pinned DNS).
- Keeps each connector's tool list in memory for 5 minutes.
- Deletes the approval requests that are settled (`allow`, `deny`, `used`, `expired`) and
  older than 7 days, counted from the answer (else the request), at start and every hour on
  each machine, with one log line giving the count (`prune.ts`). Two machines running it at
  once is fine.
- Logs one line per call (agent, connector, tool, outcome, duration), never arguments or
  results.
- Writes one `mcp_calls` row per call (`call-log.ts`): owner, agent id and name, connector id,
  key and name, tool, outcome, duration and the time it ended, never arguments, results or
  an approval preview. The write happens after the call has its answer and is never waited
  for, so a database error never fails or slows a call; a missing table (this server
  deployed before api.metro.box ran migration `0018`) is logged once. The rows are kept for
  good, also after the agent or connector is deleted, and feed the page's Live activity
  through api.metro.box's `GET /api/connectors/activity`. About 33 MB per 100,000 calls.
- Code shared with api.metro.box lives in `packages/connectors`.

## Deploy

- Fly app `metro-mcp`, region `iad`, two machines, `mcp.metro.box`.
- Secrets: `DATABASE_URL`, `METRO_CONNECTORS_KEY` (the same values as api.metro.box).
- Deployed by `.github/workflows/mcp.yml` on pushes to `main` that touch `apps/mcp/**`,
  `packages/connectors/**`, `packages/http/**`, `packages/core/**`, `bun.lock` or the
  workflow itself.

## Rollout

1. Done (beta.304): mcp.metro.box, `packages/connectors`, the token and the approval relay
   in the daemon, next to the per-connector servers. A box got the `mcp` entry only when its
   daemon had `METRO_MCP_SERVER_URL` set.
2. Done (2026-10-14): every box switched (`METRO_MCP_SERVER_URL=https://mcp.metro.box`),
   every enrolled agent registered its token and reached its connectors through
   mcp.metro.box.
3. Done (2026-10-14): the old path is gone: credential delivery to boxes
   (`POST /api/agents/connectors`), the daemon's sync, runtime, relay, discovery and server
   keys, the per-connector `.mcp.json` entries, the daemon's connector gates and the Sync
   switch. `METRO_MCP_SERVER_URL` defaults to `https://mcp.metro.box`.
4. Done (2026-10-14): no Claude Code plugin, and one MCP server. The plugin's `mcp` server
   is gone: the daemon's `metro` server carries the two connector tools, renamed
   `tool_search` and `tool_call` (Claude Code: `mcp__metro__tool_search`,
   `mcp__metro__tool_call`, were `mcp__plugin_metro_mcp__find_tools` and `…call_tool`), and
   forwards them with the token, which no longer reaches the agent. The guard and the
   standing rules became hooks the daemon writes into `~/.claude/settings.json`.
