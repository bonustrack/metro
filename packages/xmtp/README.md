# @metro-labs/xmtp

> The Metro **xmtp** station: bridges end-to-end-encrypted XMTP DMs and groups into the
> core daemon.

Private station package (part of the [Metro monorepo](../../README.md)). It depends only
on `@metro-labs/mcp` and implements the station contract from
`@metro-labs/mcp/stations/*`. The core consumes it two ways:

- as a **descriptor** — the `.` export (`station.ts` → `xmtpStation`), read by the core
  registry to route lines/verbs;
- as a **train subprocess** — the `./train` export (`index.ts`), spawned by the
  supervisor to run the live XMTP client(s).

Identity is one or more Ethereum EOAs, one raw private key per account,
running on the **XMTP production network**. Lines are
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

## Channel discovery

`list_channels` requires this station's account id. It discovers existing DMs and
groups even when Metro has seen no recent messages. Names, ids and canonical
`metro://xmtp/<account>/<conversation>` lines support case-insensitive search;
results use bounded snapshot pagination.

Discovery synchronizes conversation welcomes with `conversations.sync()`, then
lists at most 5,001 conversation metadata records to return a 5,000-entry snapshot.
It never calls `syncAll()`, reads conversation messages, expands members or looks
up profiles. Group names come from local metadata and may be stale. Results are
always partial: this installation does not necessarily know every conversation on
other devices. Duplicate DMs are excluded by the SDK.

Concurrent listings share a pending welcome sync through the existing sync queue
and network cooldown. Cursor pages stay local and remain usable during a cooldown.
A sync queued for 30 seconds is refused before it starts; an in-flight native sync
has no cancellation or time limit, so it can outlast the train call timeout.

## Configuration

Account config lives in the DB (`accounts.config` jsonb): `{ privateKey }`, the raw
EOA key; optional `owner`, `dbPath`. The
daemon materializes it to the accounts file the train reads. See the
[root README "Configuration"](../../README.md#configuration).

| Env var | Meaning |
| --- | --- |
| `XMTP_ACCOUNTS_FILE` | Optional override for the materialized accounts file path |
| `XMTP_SYNC_MS` | Optional conversation sync interval |
| `METRO_WHISPER_BIN` / `METRO_WHISPER_MODEL` / `METRO_FFMPEG_BIN` | Optional binaries for voice-note transcription |

## Constraints

XMTP keeps each inbox's MLS state in a local SQLite DB (under `~/.metro/`) that **must
persist** and is **single-writer**: only one instance may run per inbox at a time. Losing
the DB re-installs the inbox (burning the 10-installation / 256-update budget); running
the same identity in two places corrupts MLS state. Deploy as a single instance with a
persistent volume — see the [root README "Deploying"](../../README.md#deploying).
