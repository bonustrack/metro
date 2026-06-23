# @metro-labs/xmtp

> The metro **xmtp** station: bridges end-to-end-encrypted XMTP DMs and groups into the
> core daemon.

Private station package (part of the [metro monorepo](../../README.md)). It depends only
on `@metro-labs/mcp` and implements the station contract from
`@metro-labs/mcp/stations/*`. The core consumes it two ways:

- as a **descriptor** — the `.` export (`station.ts` → `xmtpStation`), read by the core
  registry to route lines/verbs;
- as a **train subprocess** — the `./train` export (`index.ts`), spawned by the
  supervisor to run the live XMTP client(s).

Identity is one or more Ethereum EOAs derived from a BIP-39 mnemonic
(`m/44'/60'/0'/0/<index>`), running on the **XMTP production network**. Lines are
`metro://xmtp/<…>`; account ids are `x0..xN`.

## Capabilities

- Message verbs: `send`, `reply`, `react`, `unreact`, `read`.
- Groups & DMs: create groups, open 1:1 DMs, group info / add & remove members /
  set channel metadata / close channel (`actions-conv.ts`, `actions-meta.ts`,
  `actions-close.ts`, `member-args.ts`).
- Content-type codecs: text, reactions, replies, remote attachments, wallet-send-calls,
  plus push notifications and AskUserQuestion-style polls (`codecs.ts`, `push.ts`,
  `actions-push.ts`). Attachments are saved/normalized via `attachments.ts`; voice
  notes can be transcribed (`transcribe.ts`).

## Env vars

| Var | Meaning |
| --- | --- |
| `MNEMONIC` | **Required.** BIP-39 mnemonic the HD accounts derive from |
| `DERIVE_COUNT` | How many accounts to derive (indices 0..N-1). Default `1` |
| `XMTP_ACCOUNTS_FILE` | Optional path to an accounts file (overrides derivation) |
| `XMTP_SYNC_MS` | Optional conversation sync interval |
| `METRO_WHISPER_BIN` / `METRO_WHISPER_MODEL` / `METRO_FFMPEG_BIN` | Optional binaries for voice-note transcription |

## Constraints

XMTP keeps each inbox's MLS state in a local SQLite DB (under `~/.metro/`) that **must
persist** and is **single-writer**: only one instance may run per inbox at a time. Losing
the DB re-installs the inbox (burning the 10-installation / 256-update budget); running
the same identity in two places corrupts MLS state. Deploy as a single instance with a
persistent volume — see the [root README "Deploying"](../../README.md#deploying).
