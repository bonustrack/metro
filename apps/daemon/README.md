# @metro-labs/daemon

What `metro serve` runs on a box. See the [root README](../../README.md) for what Metro is
and how to install it.

One Bun process that:

- serves the MCP server Claude Code connects to, at `/` and `/mcp`,
- runs one subprocess ("train") per chat network the agent uses, and passes events
  between them and Claude Code through an in-memory bus,
- serves the APIs the page at https://metro.box uses, checked against a WorkOS token whose
  organization must match the box's owner (`~/.metro/agents/.owner`),
- relays connector traffic at `/relay/<id>`,
- serves the model gateway at `/gateway`, which sends Claude Code's inference to the
  provider chosen on the Model page,
- keeps a Claude Code session running in tmux, and serves the Terminal tab.

The agent, its channels and its connectors are plain files under `~/.metro/agents`
(`METRO_AGENTS_DIR` overrides). There is no database.

## Layout

`src/server.ts` imports `boot/boot.ts`. Each folder under `src/` is one area:

| Folder | What it holds |
| --- | --- |
| `boot/` | Startup, the crash guard, paths and the lock, the owner file. |
| `routes/` | The HTTP server and the order routes are mounted in. |
| `agents/` | The agent file, keys, scope checks, and the agent and account APIs. |
| `stations/` | The station registry, attaching accounts, train files, the supervisor. |
| `mcp/` | The MCP server and its tools, one session per identity. |
| `channels/` | Bus events turned into Claude Code channel notifications. |
| `monitor/` | `GET /api/tail`, the live event stream `metro tail` reads. |
| `connectors/` | Connectors, their OAuth sign-in, the relay, the plugin's server list. |
| `gateway/` | The model gateway and the Model page API. |
| `claude/` | Claude Code on the box: sessions, memory, settings, skills, login, setup. |
| `terminal/` | The Terminal tab's WebSocket and tmux. |
| `files/` | Attachment links and uploads. |
| `net/` | The Tailscale Funnel tunnel. |
| `server/` | Stop, restart, update, and what the box knows about itself. |

The chat network packages (`packages/xmtp`, `packages/telegram`, and so on) import only
`@metro-labs/core`.

## Scripts

```sh
bun run start        # bun src/server.ts, a daemon on http://127.0.0.1:8420
bun run build        # tsc
bun run test         # tsc --noEmit, then bun test test/
```
