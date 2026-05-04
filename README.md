# Metro MCP

OAuth-protected MCP server that bridges Claude / Cursor / ChatGPT-style agents to a Telegram bot. Lets the model `notify` and `ask` you on Telegram, and exposes an `/inbox` SSE channel for live unsolicited replies.

Two binaries ship from this package:

- `metro-mcp` — the HTTP MCP server.
- `metro` — a small CLI with three subcommands: `login`, `inbox`, `watch`.

## Setup

```bash
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN, optionally OPENAI_API_KEY
bun install
bun link               # exposes `metro` and `metro-mcp` on $PATH (needs ~/.bun/bin in PATH)
```

## Mint an access token

```bash
export METRO_BASE_URL=https://your-metro     # defaults to https://mcp.bonustrack.co
export METRO_TOKEN=$(metro login)            # opens a Telegram deep link, prints the token
```

## Stream live replies into an agent (`/inbox` daemon)

```bash
metro inbox
# {"message_id":42,"date":1730000000,"text":"hi"}
```

Each Telegram message you send arrives as one JSON line. Spawn this as a background process inside an agent (Claude Code: `Bash run_in_background=true` + `Monitor`) for sub-second push to the model.

## Bridge Telegram into another Claude Code session (`metro watch`)

If you want a *different* Claude Code session — running in another repo, with no MCP tools wired in — to receive your Telegram messages live, use `metro watch`. It long-polls the bot directly and emits a human-readable log line per message:

```bash
TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… metro watch >> /tmp/metro-watch.log 2>&1
```

Output:

```
[2026-05-04T15:30:00.000Z] Alice hello world
[2026-05-04T15:30:08.000Z] Alice line one\nline two
[2026-05-04T15:30:15.000Z] Alice <image: AgACAgEAAxkBAAIB…>
[2026-05-04T15:30:22.000Z] Alice <button: confirm>
```

Then in the other Claude Code session:

> Run `tail -F /tmp/metro-watch.log` in the background and Monitor it.

Claude will start `tail` as a backgrounded `Bash` and attach `Monitor` to its stdout. Each line you send on Telegram arrives at the next agent decision boundary, and the other session can react without ever calling an MCP tool.

**Conflict caveat.** Telegram only allows one active `getUpdates` poller per bot. If `metro-mcp` is polling on the same `TELEGRAM_BOT_TOKEN`, watch will see `409 Conflict: terminated by other getUpdates request` on every poll and the two will thrash. Run watch on a separate bot, or take down the MCP poller while watch is up. The hosted `mcp.bonustrack.co` runs against its own bot, so local `metro watch` against a different bot is fine.

## Self-hosting the MCP server

```bash
PORT=8080 METRO_BASE_URL=https://your-public-url bun src/index.ts
```

OAuth 2.1 / PKCE protects everything except `/health` and the OAuth metadata endpoints. Each user binds their Telegram chat by tapping a bot deep link during `/authorize`.
