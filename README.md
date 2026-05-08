# Metro

Live Telegram + Discord ↔ Claude Code or Codex. The agent reacts to your DMs in real time, replies, edits messages, and shows a typing indicator while it works. One local stdio MCP, no hosted infra.

```
You (Telegram) ───────────────────────────────────────────────────────
  "what's on this branch?"
  👀                                            ← Metro reacts in <1s
  Bot is typing…                                ← typing while agent works
  Bot:  "5 files changed since main:
         src/server.ts, src/tail.ts, …"
```

## Quickstart

Requires [Bun](https://bun.sh) at runtime. Use any package manager you prefer to install + link:

```bash
git clone https://github.com/bonustrack/metro && cd metro

# pick one:
bun install   && bun link              #
npm install   && npm link              #  → exposes `metro` on PATH
pnpm install  && pnpm link --global    #
yarn install  && yarn link             #

cp .env.example .env && chmod 600 .env
$EDITOR .env   # paste TELEGRAM_BOT_TOKEN and/or DISCORD_BOT_TOKEN
```

Register with whichever agent(s) you use:

```bash
claude mcp add metro -- metro mcp     # Claude Code
codex  mcp add metro -- metro mcp     # Codex
```

In your agent session, ask it to start the inbound stream:

> Run `metro tail` in the background and Monitor its stdout for inbound Telegram/Discord messages.

DM your bot. The agent reacts within ~1 second.

## Bot setup

### Telegram
1. DM [@BotFather](https://t.me/BotFather), `/newbot`, copy the token
2. Paste into `.env` as `TELEGRAM_BOT_TOKEN`

### Discord
1. [discord.com/developers/applications](https://discord.com/developers/applications) → New Application → Bot → Reset Token, copy
2. Paste into `.env` as `DISCORD_BOT_TOKEN`
3. **Toggle Message Content Intent** in the same Bot tab (Privileged Gateway Intents) — without it, message bodies arrive empty
4. Generate an OAuth invite link with the `bot` scope and invite to your server (or just DM the bot directly)

## Tools the agent gets

|  | Telegram | Discord |
|---|---|---|
| Reply | `telegram-reply` | `discord-reply` |
| React | `telegram-react` | `discord-react` |
| Edit message | `telegram-edit-message` | `discord-edit-message` |
| Download attachment | `telegram-download-attachment` | `discord-download-attachment` |
| Fetch recent messages | — | `discord-fetch-messages` |

The agent reads `chat_id` / `channel_id` and `message_id` from the inbound JSON and threads them through. Voice / audio surface as `[voice]` / `[audio]` placeholders. `discord-fetch-messages` is the only lookback path on Discord — Discord exposes no search API for bots.

## Config

`<repo-root>/.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC…
DISCORD_BOT_TOKEN=MTIz…

METRO_LOG_LEVEL=info     # trace|debug|info|warn|error|fatal — default info
METRO_ACK_EMOJI=👀       # auto-react on every inbound; empty disables.
                         # Telegram restricts the bot reaction whitelist.
```

Logs go to stderr. Claude Code captures them at `~/Library/Caches/claude-cli-nodejs/…/mcp-logs-plugin-metro-metro/*.jsonl`.

## Architecture

```
Telegram ─poll(getUpdates)──┐
                            ├─▶ metro tail ─stdout JSONL─▶ agent (Monitor / unified_exec)
Discord  ─gateway WS────────┘
                                                    │
                                                    └─▶ metro mcp (MCP) ◀─ tool calls
                                                       reply / react / edit / download / fetch
```

Two commands, same approach on both runtimes. While the agent works on a reply, both platforms show a typing indicator; when the agent replies, the indicator stops and the auto-acknowledgement reaction is cleared on the exact message replied to.

## Troubleshooting

```bash
# Sanity-check the binary:
which metro                                              # → e.g. ~/.bun/bin/metro
metro                                                    # prints usage

# What's running right now:
ps aux | grep metro | grep -v grep
# expect: one `metro mcp`, optionally one `metro tail` (if agent has spawned it)

# Clean stuck state — safe to run anytime:
rm -f .tail-lock telegram-attachments.json
rm -rf .typing-stop/

# Tail the latest agent-side log (Claude Code):
ls -t ~/Library/Caches/claude-cli-nodejs/-Users-*-metro/mcp-logs-plugin-metro-metro/*.jsonl | head -1 | xargs cat
```

## Caveats

- **Discord Message Content Intent** is privileged — toggle it in the Developer Portal. See above.
- **Telegram single-poller.** Telegram allows one `getUpdates` consumer per bot token. If two `metro tail` instances start, the second-comer detects the lockfile (`.tail-lock`) and exits cleanly. Re-run `metro tail` to take over after the previous one exits.
- **No allowlist.** Anyone who can DM your bot or @-mention it can talk to your session. Run against bots you own.
- **Mid-task latency.** New messages surface at the next agent decision boundary — sub-second on Claude Code (lots of small tool calls), longer on Codex turns. Neither runtime can interrupt an in-progress LLM generation.
- **UI visibility.** Claude Code's `Monitor` collapses stdout into a card; Codex dims MCP tool args. Metro's MCP `instructions` direct the agent to echo each inbound in its visible reply so you see what arrived without expanding cards.
