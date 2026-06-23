# @metro-labs/discord

> The metro **discord** station: bridges the Discord bot gateway + REST into the core
> daemon.

Private station package (part of the [metro monorepo](../../README.md)). It depends on
`@metro-labs/mcp` (plus `discord.js`, `@discordjs/voice`, `prism-media`) and implements
the station contract from `@metro-labs/mcp/stations/*`. The core consumes it two ways:

- as a **descriptor** — the `.` export (`station.ts` → `discordStation`), read by the
  core registry to route lines/verbs;
- as a **train subprocess** — the `./train` export (`index.ts`), spawned by the
  supervisor to run the live bot(s).

One or many bots from a comma-separated token list, each its own account (ids `d0..dN`).
Lines are account-scoped (`metro://discord/<account>/<channel>`).

## Capabilities

- Message verbs: `send`, `reply`, `react`, `unreact`, `edit`, `delete`, `read`.
- Attachments normalized to canonical form (`attachments.ts`).
- **Voice**: join/leave voice channels, speak (TTS), and transcribe — `voice.ts`,
  `voice-speak.ts`, `voice-transcribe.ts` (via `@discordjs/voice` + `prism-media`).

## Env vars

| Var | Meaning |
| --- | --- |
| `DISCORD_BOT_TOKENS` | **Required.** Comma-separated bot tokens → one bot each |
| `DISCORD_ACCOUNTS_FILE` | Optional path to an accounts file (overrides the token list) |
| `FFMPEG_BIN` | Optional ffmpeg binary for voice audio |
| `WHISPER_CLI` / `WHISPER_MODEL` | Optional whisper binary + model for voice transcription |

## Constraints

- Enable the **Message Content Intent** in the Discord developer portal (Bot tab →
  Privileged Gateway Intents) — without it `messageCreate` events arrive with empty
  content.
- Voice requires the native deps (`@discordjs/voice`, `prism-media`) and an `ffmpeg`
  binary present at runtime.

No persistent state of its own — safe to restart.
