# mcp.metro.box

`apps/mcp` (package `@metro-labs/mcp`, Fly app `metro-mcp`, `https://mcp.metro.box`)
is the one MCP endpoint every agent uses for its connectors. It is its own app with its own
deploy, so a change to api.metro.box, the page or the daemon never redeploys it. Later it
will also serve memory.

## Why

Before (until 2026-10-14), each box received its connectors' credentials from
api.metro.box, kept them in memory, and published every connector to Claude Code as its own
MCP server: ten connectors meant ten servers and hundreds of tool definitions, and
credentials travelled to every box.

Now:

- The agent connects to one MCP endpoint, `https://mcp.metro.box`, with its own token.
- It finds tools with `find_tools` (the design of Claude Code's `ToolSearch`) and runs
  them with `call_tool`. Definitions load only when asked for.
- Every connector call runs from mcp.metro.box. Credentials never leave Metro's servers.
- Any MCP client can use it, not only Claude Code.

Claude Code has two Metro servers: `metro` (the daemon on the box: chats, channels, sending
messages) and `mcp` (this one: connectors).

## The agent's view

The endpoint is Streamable HTTP at `/` (also `/mcp`), JSON answers, no session state. Every
request carries `Authorization: Bearer <MCP token>`.

### `find_tools`

- Input: `{ query: string, max_results?: number }` (default 5, at most 20).
- Query forms, as `ToolSearch`:
  - `select:notion.search,linear.create_issue` returns those exact tools.
  - Keywords (`notion page update`) rank tools by how well their name and description match.
  - `+slack send` requires `slack` in the tool name and ranks the rest by the other words.
- Output: one text block in the `ToolSearch` encoding:

  ```
  <functions>
  <function>{"name":"notion.search","description":"…","parameters":{…JSON schema…}}</function>
  </functions>
  ```

  No match answers `No tool matched "<query>".` and names the agent's connectors.
- The tool's description (from `tools/list`) names the agent's connectors.
- Tools the owner blocked are never returned.

### `call_tool`

- Input: `{ calls: [{ tool: "notion.search", arguments: { … }, approval?: "abcde" }] }`, 1 to
  10 independent calls, run in parallel, answered in order.
- Output: for each call, a text header `[1] notion.search` followed by the vendor's content
  blocks as they came (text, images, resources), or one line saying why it did not run. The
  result is an error only when every call failed.
- A tool name is `<connector key>.<tool>`. The key is the connector's name as a slug
  (`n8n-anderra`), with a short suffix only when two connectors assigned to the same agent
  share a slug. Keys are stable while the agent's assignments do not change.

## Permissions and approvals

Allow / Ask / Block per connector, for Read, Write and each tool, at the organization and
the agent level (the stricter wins). Read means the vendor marked the tool read-only;
anything else is Write. mcp.metro.box reads the policies from the database on every call.

- **Block**: hidden from `find_tools`; `call_tool` answers
  `Blocked by the owner's policy for <connector> (<tool>).`
- **Ask**: the first call answers `needs_approval` with a 5-letter id and a sentence for the
  agent. mcp.metro.box records the request (tool, a digest of the arguments, a short
  preview) and hands it to the agent's daemon, which asks the owner exactly as today: a
  chat message (`Approval needed: notion.update_page`, the arguments, then
  `Reply "yes <id>" or "no <id>"`) on the agent's last chat line, and the page's
  approvals list. The owner's answer goes back to mcp.metro.box, and the daemon tells the
  agent in its channel (`Approved: notion.update_page (abcde)` or `Denied: …`). The agent
  then calls `call_tool` again with the same tool and arguments and `approval: "abcde"`.
  An approval works once, for exactly that tool and those arguments, within 10 minutes of
  the answer. Unanswered requests expire after 24 hours (denied).
- The agent can never approve its own call: answers come only from the daemon's signed
  requests (the enrollment signing key lives in Metro's folder, which the agent user cannot
  read) after an allowlisted approver answered in chat, or from the page.
- `call_tool` is a worker tool: the orchestrator guard denies it on the main thread, as it
  denied every connector tool before. `find_tools` is allowed everywhere.

## The MCP token

- 32 random bytes, `mcp_<base64url>`. The daemon creates it when the agent is enrolled (or
  when it has none), sends only its SHA-256 to mcp.metro.box with a signed request, and
  keeps the token in the agent's own folder (`<agent home>/.metro/agents/mcp-token`, 0600,
  the agent user's).
- The plugin's `.mcp.json` has one entry, `mcp`, pointing at `https://mcp.metro.box`, whose
  `headersHelper` prints `Bearer <token>`. The token is never written into the file.
- Enrolling again replaces it. A token whose agent left its organization stops working at
  once.

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

The daemon talks to `https://mcp.metro.box` unless `METRO_MCP_SERVER_URL` names another
url (https, or http on this machine only); an empty value turns the client off.

## Inside mcp.metro.box

- Reads connectors, assignments, policies and agent keys from api.metro.box's Postgres (the
  same database; migrations still run from `apps/api` only). Its own tables: the token hash
  on the agent key row and `mcp_approvals`.
- Opens a connector's credential with `METRO_CONNECTORS_KEY`, refreshes OAuth tokens (single
  flight, the same rules and uncertainty records as api.metro.box), and calls the vendor
  through the same safe egress (HTTPS only, no redirects, no private addresses, pinned DNS).
- Keeps each connector's tool list in memory for 5 minutes.
- Logs one line per call (agent, connector, tool, outcome, duration), never arguments or
  results.
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
