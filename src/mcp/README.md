# Metro MCP (Claude Code Channel surface)

Pushes Metro inbound chat (XMTP/Telegram/Discord) into a **running** Claude Code
session as [channel](https://code.claude.com/docs/en/channels) events, so CC reacts to
messages while you're away. Two-way: the full messaging verb set
(send/reply/react/unreact/edit/delete/read) is exposed as tools to send responses back,
and tool-approval prompts are relayed to chat so you can approve/deny from your phone.

The MCP is **served in-process by the metro daemon** — it is not a separate server.
`createMetroMcp()` ([`index.ts`](index.ts)) is mounted at the **root path** of the
daemon's HTTP server. Inbound is an in-process push: the dispatcher's `emit()`
publishes each event to the in-process event bus ([`event-bus.ts`](../event-bus.ts)),
which the MCP `InboundRelay` subscribes to directly. Outbound tool calls go straight
to the stations over the in-process IPC (`ipcCall` forward-call) — no HTTP bridge,
no shared token, no on-disk journal.

```
 XMTP/TG/Discord ──▶ stations ──▶ dispatcher emit ──▶ event bus ──subscribe──▶ MCP ──▶ AI client
       ▲                 ▲                                                       │
       └── reply ────────┴───────────────────── ipcCall forward-call ◀──────────┘
```

## CLI parity tools

The server exposes the full messaging verb set as MCP tools (one tool per verb). Every
tool takes the `line` from the inbound `<channel>` tag; the station is derived from the
line, so there is no station argument. Each tool dispatches the canonical action
**in-process** (`ipcCall` forward-call); the daemon's normalize layer translates to each
station's native action.

| Tool | Args | Action sent |
| --- | --- | --- |
| `send` | `line, text?, reply_to?, attachments?` | `send` (xmtp media dispatched natively, see below) |
| `reply` | `line, message_id, text` | `reply {replyTo: message_id}` |
| `react` | `line, message_id, emoji` | `react {messageId, emoji}` |
| `unreact` | `line, message_id, emoji` | `unreact {messageId, emoji}` |
| `edit` | `line, message_id, text` | `edit {messageId, text}` |
| `delete` | `line, message_id` | `delete {messageId}` |
| `read` | `line, limit?, before?, since?` | `read` (returns raw history JSON) |

(Plus the XMTP channel/group tools: `create_channel`, `dm`, `group_info`, `add_members`,
`remove_members`, `close_channel`, `set_channel_metadata`, `ask`, and `list_accounts`.)

### Per-station support matrix

The single source of truth is each station's `messageVerbs` set (`stations/<station>/station.ts`).
This table is generated to mirror those sets; the `list_accounts` tool returns the same data
at runtime under `capabilities`, so an agent never has to discover support by trial and error.

| Verb | xmtp | telegram | discord | webhook |
| --- | --- | --- | --- | --- |
| send | yes | yes | yes | N/A |
| reply | yes | yes | yes | N/A |
| react | yes | yes | yes | N/A |
| unreact | yes | yes | yes | N/A |
| edit | no | yes | yes | N/A |
| delete | no | yes | yes | N/A |
| read | yes | no | yes | N/A |

- **webhook**: no outbound at all (empty `messageVerbs`). Every verb is rejected up front
  with a clear message.
- **xmtp**: no `edit`/`delete` - the daemon returns `unsupported verb '<verb>' on xmtp`,
  surfaced verbatim as the tool error.
- **telegram**: no `read` - the daemon returns an unsupported-verb error, surfaced verbatim.

The `messageVerbs` set gates only the all-or-nothing case (a station with no outbound verbs,
i.e. webhook, is rejected up front). Per-verb unsupported cases are not pre-blocked: the
daemon's reason is returned as the tool result with `isError` semantics so the model sees why
it failed. `read` returns the raw history JSON (shapes differ per station and are not
normalized).

### File support notes

- **telegram / discord**: `send` attachments are passed as canonical descriptors
  (`{kind, url: <local path>, name}`); the daemon reads the local path and builds the
  native multipart upload. Pass `path` (preferred) or `url` per attachment.
- **xmtp**: the `send` action ignores canonical attachments, so each attachment is
  dispatched natively - images (by mime or extension) via `sendImage {line, path}` (the
  daemon reads the file, no base64 round-trip), other files via `sendAttachment` with the
  bytes base64-encoded in the server. An xmtp non-image file over ~190 KiB is rejected
  with a clear error (a guard in the server, since base64 inflates large payloads).
- `reply` carries no attachments (matches the CLI); use `send` for media.
- MIME is inferred from the file extension when not provided (covers image/*, audio/*,
  video/*, application/pdf, and others).

## Reactions and attachments

**Inbound reactions** are forwarded as channel pushes. An emoji react surfaces as
`👍 reacted to message <shortId>`; on xmtp, un-reacting surfaces as
`👍 removed from message <shortId>`. Other event types (edits/deletes/system) are dropped.

**Inbound attachments** (image/video/audio) ride a two-event flow: the daemon emits the
`msg` event first, then a follow-up `attachmentSaved` event (one per index) carrying the
saved file path, correlated by the top-level event `id`. The server buffers the `msg`,
waits for the `attachmentSaved`, then forwards. Channel content is **string-only** (no
image content blocks), so an image is forwarded as a readable local file **path** that CC
can open with Read. Images over the 4MB gate, and any non-image attachment, fall back to
the path inline in the text.

**Outbound media**: the `send` tool takes an optional `attachments` array
(`[{path|url, mime?, name?}]`). On telegram/discord they ride the canonical `send` action
(daemon reads the local path); on xmtp images route to `sendImage` and other files to
`sendAttachment` (read + base64 in the server, with the ~190 KiB cap).

## Requirements

- Claude Code **v2.1.80+** (permission relay needs **v2.1.81+**)
- [Bun](https://bun.sh)
- The metro daemon running (`bun run start`) — the MCP is served by it, in-process.
- Anthropic auth via claude.ai or Console API key (channels are not on Bedrock/Vertex/Foundry).
  On Team/Enterprise an admin must set `channelsEnabled: true`.

## Configure (env vars)

The MCP reads only the sender allowlist + station gate from the environment (the daemon
loads `.env`), evaluated at launch.

| Var | Default | Purpose |
| --- | --- | --- |
| `METRO_CHANNEL_ALLOWLIST` | Less's tony-account inbox id | Comma-separated allowed sender URIs or trailing ids. Inbound from senders not on the list is dropped. `*` disables gating (unsafe). |
| `METRO_CHANNEL_STATIONS` | `xmtp,telegram,discord` | Stations to surface. **`webhook` is always excluded** (flood/crash risk). |
| `METRO_MCP_HTTP_TOKEN` | (off) | Optional bearer gating the MCP endpoint for external clients. |

The allowlist gates on the **sender** (`from`), never the conversation - prompt-injection
defense per the Channels spec. Only allowlisted senders can drive tools or answer
permission prompts. Both are read from `process.env` at launch; to change them, update
the daemon's `.env` and **relaunch**.

## Run

The MCP comes up with the daemon — one process, one port:

```bash
bun run start
# MCP : http://127.0.0.1:8420   (root path; POST = JSON-RPC, GET = server→client SSE)
#       optional METRO_MCP_HTTP_TOKEN bearer
```

Register it in an MCP client (this directory's `.mcp.json` points `metro` at
`http://127.0.0.1:8420`). For Claude Code add the development-channel flag (custom
channels aren't on the Anthropic allowlist during the research preview):

```bash
claude --dangerously-load-development-channels server:metro
```

A dim banner confirms: `Channels (experimental) messages from server:metro inject directly...`.

## Live test plan

1. **Daemon up**: `bun run start`; confirm stations via `GET http://127.0.0.1:8420/health`.
2. **Start CC as a channel** (command above) from the repo root. Run `/mcp` - `metro`
   should show connected.
3. **Inbound**: from your phone, send a message on an allowlisted line. It arrives in the
   CC session as `<channel source="metro" line="metro://xmtp/..." from="..." station="..."
   message_id="...">your text</channel>`.
4. **Reply**: tell CC to answer. It calls the `reply` tool with that `line`; the message
   lands back in the conversation on your phone. The CC terminal shows only `sent`.
5. **Permission relay**: ask CC to do something needing approval (e.g. a write/Bash). The
   local dialog opens AND a `Claude wants to run ... Reply "yes <id>"/"no <id>"` prompt
   arrives in the chat. Reply `yes <id>` from your phone - the tool proceeds. (Answer in
   the terminal too; first answer wins.)

## Notes / spec uncertainties

- Built to the [Channels reference](https://code.claude.com/docs/en/channels-reference):
  `notifications/claude/channel` (push), `reply` tool, `notifications/claude/channel/permission_request`
  + `notifications/claude/channel/permission` (relay). Meta keys are identifiers only
  (underscores), so the metro line rides as `line` (it's a value, not a key).
- The allowlist + station gate come from the **daemon's `.env`** (the MCP runs in its
  process). The client's `.mcp.json` only carries the URL — no env block is needed.
- Permission relay routes to the **last inbound line** seen. With a single active
  conversation that is exact; multi-conversation routing would need per-request line capture
  (CC's `permission_request` doesn't carry a conversation id, so last-line is the documented pattern).
