# @metro-labs/discord

> The Metro **discord** station: bridges the Discord bot gateway + REST into the core
> daemon.

Private station package (part of the [Metro monorepo](../../README.md)). It depends on
`@metro-labs/mcp` (plus `discord.js`, `@discordjs/voice`, `prism-media`) and implements
the station contract from `@metro-labs/mcp/stations/*`. The core consumes it two ways:

- as a **descriptor** — the `.` export (`station.ts` → `discordStation`), read by the
  core registry to route lines/verbs;
- as a **train subprocess** — the `./train` export (`index.ts`), spawned by the
  supervisor to run the live bot(s).

One or many bots, each a `discord` account row in the DB (ids `d0..dN`).
Lines are account-scoped (`metro://discord/<account>/<channel>`).

## Capabilities

- Message verbs: `send`, `reply`, `react`, `unreact`, `edit`, `delete`, `read`.
- Attachments normalized to canonical form (`attachments.ts`).
- **Voice**: join/leave voice channels, speak (TTS), and transcribe — `voice.ts`,
  `voice-speak.ts`, `voice-transcribe.ts` (via `@discordjs/voice` + `prism-media`).

## Configuration

Each bot is a `discord` account row in the DB with `{ token }` in `accounts.config`
jsonb; optional `owner`. The daemon materializes it to the accounts file the train
reads. See the [root README "Configuration"](../../README.md#configuration).

| Env var | Meaning |
| --- | --- |
| `DISCORD_ONLY_ACCOUNTS` / `DISCORD_ACCOUNTS` | Optional comma-separated `account_id` filter — boot only these accounts |
| `DISCORD_ACCOUNTS_FILE` | Optional override for the materialized accounts file path |
| `FFMPEG_BIN` | Optional ffmpeg binary for voice audio |
| `WHISPER_CLI` / `WHISPER_MODEL` | Optional whisper binary + model for voice transcription |

## Task status on the bot custom status

`scripts/task-status.ts` is an operator script that publishes a short live task
summary (`3 working, 2 queued`, or `idle`) as the bot's Discord custom status.

It runs **where the agent runs**, never on the daemon: the counts come from that
box's own `agent-status --json` report, and the daemon is a separate service that
cannot read another machine's logs. It needs no new daemon route — it calls the
existing `set_presence` action through `POST /api/call/discord/set_presence`,
authenticated with that agent's own `agents.key`, which `callTargetDenied` already
scopes to that agent's own discord account.

`working` is agents in the `run` state and `queued` is queue entries in the
`queued` state, both taken from `agent-status` so the status and that tool's own
table can never disagree. It publishes only when the text changes, and re-asserts
when `/health` reports the daemon restarted (a restart clears the gateway
presence). A report it cannot parse is an error, not a zero, so a failed read
leaves the last good status up rather than replacing it with `idle`.

| Env var | Meaning |
| --- | --- |
| `METRO_URL` | Daemon base url |
| `METRO_KEY` | This agent's metro key |
| `DISCORD_ACCOUNT` | Which discord account to set the status on |
| `AGENT_STATUS_BIN` | Optional path to `agent-status` (default: on `PATH`) |
| `METRO_PRESENCE_STATE` | Optional path for the last-published record |

It also reports the live view to the daemon with `POST /api/agent-runs` (`{"report":[…]}`),
which is what the panel draws per agent: one row per running subagent and per owed queue
entry. That report goes on **every** run, not only when the numbers change: the panel
shows the age of the last report and greys a stale one, so the timestamp has to keep
moving while the reporter is alive or staleness would mean nothing. The presence update
stays change-only, because that one is rate limited and the status is identical anyway.

`METRO_REPORT_INTERVAL=20` runs it as a loop instead of a one-shot, which is the cadence
the panel wants. `METRO_REPORT_REDACT=1` sends the rows **redacted**: every task label
becomes one word from a fixed vocabulary and `who`, `needs` and the blocker are dropped,
so the output alphabet is closed and no task text can leave the box at all. Use it for any
surface thinner than the session-gated panel.

## Constraints

- Enable the **Message Content Intent** in the Discord developer portal (Bot tab →
  Privileged Gateway Intents) — without it `messageCreate` events arrive with empty
  content.
- Voice requires the native deps (`@discordjs/voice`, `prism-media`) and an `ffmpeg`
  binary present at runtime.

No persistent state of its own — safe to restart.
