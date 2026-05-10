# Metro

Chat with your Claude Code or Codex agent over Telegram and Discord. Inbound messages stream into the session live; the agent reacts, types while it works, and replies — pure CLI, ~700 lines of TypeScript, no MCP, no hosted infra.

## Quickstart

```bash
npm install -g @stage-labs/metro@beta    # or: bun add -g @stage-labs/metro@beta
```

> The `@beta` tag is required while Metro is in prerelease.

Set tokens (export, your shell rc, or `./.env`):

```bash
export TELEGRAM_BOT_TOKEN=123:ABC…
export DISCORD_BOT_TOKEN=MTIz…
```

Both are optional — configure at least one of Telegram or Discord. Then in your agent session:

> Run `metro tail` in the background and Monitor its stdout for inbound messages. Each line is `{"platform":…, "to":…, "text":…}`. For each one: echo `[<to>] <text>` so I see it, then act with `metro reply --to=<to> --text=<reply>` (or `metro react`, `metro edit`, `metro download`, `metro fetch`). Run `metro` for the full reference.

DM your bot. The agent reacts on its next decision boundary (see Caveats for latency notes).

## Bot tokens

- **Telegram**: DM [@BotFather](https://t.me/BotFather), `/newbot`, copy the token.
- **Discord**: [discord.com/developers/applications](https://discord.com/developers/applications) → New Application → Bot → Reset Token. **Toggle Message Content Intent** in the same Bot tab (Privileged Gateway Intents) — without it, message bodies arrive empty. Generate an OAuth invite with the `bot` scope, or DM the bot directly.

## How it works

Two subcommands:

- **`metro tail`** — long-running inbound stream. Polls Telegram and connects to Discord's gateway, then prints one JSON line per inbound message on stdout: `{"platform": "telegram"|"discord", "to": "<platform>:<chat>/<message_id>", "text": "…"}`. The agent watches that stdout (Bash+Monitor in Claude Code, unified_exec in Codex) and acts on each line at its next decision boundary.
- **`metro <reply|react|edit|download|fetch>`** — one-shot subcommands the agent invokes via Bash to act on those inbounds. All of them take a single `--to=<platform>:<chat>/<message_id>` address that the agent copies verbatim from the inbound line.

While the agent works on a reply, both platforms show a typing indicator; when it replies, the indicator stops and the auto-ack reaction (👀) is cleared on the exact message replied to.

## Subcommands

| Command | Purpose |
|---|---|
| `metro reply --to=<addr> --text=<t>` | Quote-reply, threading under the original. Clears the 👀 auto-ack. |
| `metro react --to=<addr> --emoji=<e>` | Set or clear (`''`) an emoji reaction. |
| `metro edit --to=<addr> --text=<t>` | Edit a message the bot previously sent. |
| `metro download --to=<addr> [--out=<dir>]` | Pull image attachments to disk; prints absolute paths (one per line) so the agent can `Read` them. |
| `metro fetch --to=<addr> [--limit=N]` | Recent-message lookback. Discord only — pass channel-only `discord:<channel_id>`. (Discord exposes no search API for bots; Telegram has none either.) |

Address format: `telegram:<chat_id>/<message_id>` or `discord:<channel_id>/<message_id>` (or `discord:<channel_id>` for `fetch`). All of these come straight off the inbound line.

`reply` and `edit` take `--text` either as a flag or via stdin (heredoc-friendly for multi-line replies). Telegram-only options: `--parse-mode=HTML|MarkdownV2`, `--no-link-preview`, `--buttons-json='[[{"text":"x","url":"https://…"}]]'`.

Voice / audio surface as `[voice]` / `[audio]` text placeholders — the agent sees them but can't download.

## Config

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token. Required for the Telegram channel. |
| `DISCORD_BOT_TOKEN` | — | Discord bot token. Required for the Discord channel. |
| `METRO_LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal`. |
| `METRO_STATE_DIR` | `~/.cache/metro` | Where the lockfile, typing-stop signals, and the Telegram attachment cache live. Also the default `--out` for `metro download` (`<state-dir>/attachments/`). |

Tokens come from the process environment. For local dev: `cp .env.example .env && chmod 600 .env`, then run `metro tail` from the repo dir — `.env` is read as a fallback when env vars aren't set. Logs go to stderr.

## Troubleshooting

```bash
which metro                                # → e.g. ~/.bun/bin/metro
metro                                      # prints usage

ps aux | grep metro | grep -v grep         # one `metro tail` running

rm -rf ~/.cache/metro/                     # clean stuck state — or whatever METRO_STATE_DIR points at
```

## Caveats

- **Discord Message Content Intent** is privileged — toggle it in the Developer Portal. See above.
- **Telegram single-poller.** Telegram allows one `getUpdates` consumer per bot token. If two `metro tail` instances start, the second-comer detects the lockfile (`$METRO_STATE_DIR/.tail-lock`) and exits cleanly. Re-run after the first exits to take over.
- **No allowlist.** Anyone who can DM your bot or @-mention it can talk to your session. Run against bots you own.
- **Mid-task latency.** New messages surface at the next agent decision boundary — sub-second on Claude Code (lots of small tool calls), longer on Codex turns. Neither runtime can interrupt an in-progress LLM generation.
- **UI visibility.** Claude Code's `Monitor` collapses stdout into a card; Codex dims tool args. Have the agent echo each inbound on its own visible line so you see what arrived without expanding cards (see the Quickstart prompt).
