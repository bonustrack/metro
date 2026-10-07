# @metro-labs/whatsapp

WhatsApp station for Metro. Uses a **real WhatsApp account** over the multi-device
Web protocol via [Baileys](https://github.com/WhiskeySockets/Baileys) (`baileys`, the
package `@whiskeysockets/baileys` was renamed to) — a WebSocket client, no browser and no
Business/Cloud bot API.

Config (`accounts` row `config` jsonb): `{ "phone": "<E.164 digits>" }`, optional `owner`.
`account_id` convention: `w0`. Lines are `metro://whatsapp/<account>/<jid>` where `<jid>`
is a WhatsApp jid (`<number>@s.whatsapp.net` for DMs, `<id>@g.us` for groups).

## Message history and group members

`read` queries one conversation's account-local history, newest first. It supports
`limit`, `before` (an exclusive message ID in that conversation) and `since` (an
inclusive timestamp). An unknown or expired cursor is an error. Advanced filters
are reported as ignored by the daemon. Account-wide reads are not supported.

History contains text, captions and attachment metadata from messages observed or
synced to this installation. Own sends are retained after the existing send verdict
accepts them, only when their disappearing-message expiry is known. Unknown expiry
means omitted history, not a failed send. It does not download historical attachments
or replay history into the agent. Every result reports partial coverage and the retained
range and limits. Empty results never prove the conversation is empty. This is not
arbitrary server-side search or an automatic request for older history.
A stored outgoing message is not proof of recipient delivery or reading. Group sends
snapshot the current group timer. Direct-chat sends use explicit timer metadata
observed on the current connection; missing metadata does not mean the timer is off.

Local history is stored in `whatsapp-history-<account>.json`, mode 0600, under
`WHATSAPP_TOKEN_DIR` or `~/.metro`. It retains at most 30 days, 5,000 messages per
account, 500 per conversation and 8 MiB per file. Text is capped at 16 KiB per
message and reports truncation. A read returns at most 100 messages within a 2 MiB
serialized page budget; `nextBefore` continues a page stopped by either limit.
Expired and deleted content is removed; replay protection prevents old syncs from
restoring it. If a phone-side chat clear has no usable message range, reads of that
conversation are refused rather than guessing which messages were cleared. Other
conversations and newer stored rows are not deleted by that unknown range.
View-once messages and disappearing content with an unknown expiry are not retained.
Detaching an account removes its history and known atomic temporary files. Startup
removes orphaned history files and this account's stale atomic files. On SIGTERM or
SIGINT, the train stops accepting work and flushes history before awaiting socket close.

`list_members` reads the current group metadata for a `@g.us` line. Original member
IDs, phone and LID aliases and admin roles are preserved. A limited roster, a mismatch
with the server's member count, or a missing total is marked incomplete. Direct chats
return an unsupported capability. This adds no group-write operations.

Both tools use the existing account scope and owner read policy. Receive Off still
only stops live inbound delivery; it does not disable the account's tools.

History requires the patched WhatsApp dependency shipped with the CLI. A long-lived
`metro serve` parent from an older CLI can keep its old dependency installer after
Update. Restart the parent service after updating; restarting only the daemon child
is not enough. When deletion support is absent, history reads report unavailable,
retention is disabled, and existing history is invalidated so missed phone-side clears
cannot expose stale content later. Live messaging, sends and group-member lookup
remain available.

## Channel discovery

`list_channels` requires an account and returns metadata only: canonical `line`, `id`,
optional `name` and `kind`. Every fresh listing reads participating groups with the
existing socket's `groupFetchAllParticipating`, including groups with no recent message.
Direct chats come only from chat metadata in live chat events and history syncs, never
from the contact roster or message bodies. WhatsApp has no API to enumerate all direct
chats, and this tool does not enumerate WhatsApp channels, so coverage is always partial
(`source: mixed`, `complete: false`). A remote group-list failure is reported, not replaced
by a misleading empty list.

At most 5,000 observed direct-chat records, including deletion markers, are retained in
`whatsapp-channels-<account>.json` under `WHATSAPP_TOKEN_DIR` or `~/.metro`, mode 0600.
Only chat IDs, names and deletion cutoffs are stored, with names capped at 256 characters.
Chat deletion or clearing removes the entry. Retained deletion markers reject history
syncs and title-only updates. A live chat update or upsert restores it only with message
activity newer than the deletion cutoff and not in the future. Same-second activity
without that proof stays omitted; legacy deletion markers use their load time as cutoff.
Detaching an account and startup orphan cleanup remove its channel metadata file.
No historical message or media is replayed or downloaded by discovery, and no new socket,
contact lookup, send or history request is started. Existing history deletion and send
expiry handling are unchanged.

`query` is a case-insensitive substring of a name or ID (200 characters at most).
`limit` defaults to 50 and accepts integers from 1 to 100. `next_cursor` continues the same bounded
metadata snapshot, tied to the account and query and expiring after five minutes.
An existing snapshot can be paged during reconnection without waiting for the socket;
a fresh listing still waits for it. Disconnected or replaced clients cannot reuse it.
Exhausting a snapshot never makes a partial directory complete. Receive Off still only
stops inbound delivery, not read tools.

## Persistence

The Baileys auth blob (`{ creds }`) lives in **Postgres**, in the `credentials` jsonb
column of the account's `accounts` row. The running train is **read-only** here: at boot
it loads `accounts.credentials` for the account via the
`@metro-labs/mcp/db/whatsapp-creds` adapter (`src/auth-state.ts`, `useAccountAuthState`),
holds creds + Signal keys **in memory** for the session, and never writes back —
`saveCreds` and `keys.set` are in-memory only. Signal sessions re-establish on demand, so
no per-key writeback is needed; the pairing survives deploys and volume loss with no
`/data` files. If `accounts.credentials` is missing at boot the train fails loud (no
fallback) — run the login script to pair.

Only the login script (a manual admin action) ever writes `accounts.credentials`.

### Trusted-contact token cache

Baileys 7 attaches a **trusted-contact token** (`tctoken`) to every 1:1 send, and WhatsApp
answers a 1:1 send that carries none with `ack error 463` — it counts the message as
reaching out to a stranger and puts the account under a reach-out timelock. The tokens are
not ours to mint: a contact issues one to us, and Baileys stores it under the
`tctoken` key type in the auth key store, which for metro is memory that dies with the
train. **An empty token store on a restart is the 463 back**, one refused send per contact
per deploy, and each refusal deepens the lock.

So exactly two key types are durable, and no others:
`tctoken` and `lid-mapping` (the PN ↔ LID index the token is filed under). They live in
`~/.metro/whatsapp-tokens-<account>.json`, 0600, written debounced through the same
`writeSecure` the daemon uses (`src/token-store.ts`), and seeded back into the key store on
the next boot. `HOME=/data` on Fly, so the file is on the mounted volume and survives a
deploy. Losing it is a degradation, never a failure: the state is exactly what it was
before this existed, and Baileys re-acquires a token from the contact or from its own
post-463 recovery issuance.

Signal session material — `session`, `pre-key`, `sender-key`, `identity-key`,
`app-state-sync-key`, `device-list` — is deliberately **not** written. It re-establishes on
demand, `creds` (which carries the pre-key counters) is still never written back, and
persisting half of a Signal state is worse than persisting none of it. The pairing
credential itself still lives only in Postgres and still survives volume loss.

## Login (once, when the number is provisioned)

```sh
WHATSAPP_PHONE=447700900123 bun packages/whatsapp/scripts/login.ts       # pairing code
# or
bun packages/whatsapp/scripts/login.ts --qr                              # QR
```

`DATABASE_URL` must be set — the pairing is written straight to `accounts.credentials` for
the account (`WHATSAPP_ACCOUNT`, default `w0`), which must already exist. Enter the code /
scan the QR in WhatsApp → Settings → Linked Devices → Link a Device; restart the daemon to
pick up the new creds.

## Baileys log level

`METRO_WHATSAPP_LOG_LEVEL` sets how much Baileys itself says on the train's stderr, which
the daemon relays into the Fly log. Default `warn`; accepted values are `trace`, `debug`,
`info`, `warn`, `error` and `silent`, and anything else falls back to `warn`. The evidence
for a send that never arrived — `recv retry request, but message not available`, and the
device-list and session-fetch decisions — is logged by Baileys at **`debug`**, so a
resend investigation needs `debug` and nothing less. It is chatty on a live account: set
it for the window (`fly secrets set METRO_WHATSAPP_LOG_LEVEL=debug`) and take it off again
(`fly secrets unset METRO_WHATSAPP_LOG_LEVEL`) rather than leaving it on.

Baileys 7 says `error 463: account restricted or missing tctoken for contact` at **`warn`**,
so the default level shows it.

## Media download timeouts are metro's now

Baileys 6 took an axios config on `downloadMediaMessage` and metro set a 60s timeout on it.
Baileys 7 fetches with `fetch` and `getHttpStream` forwards only `dispatcher`, `method` and
`headers` — a `signal` handed to it is accepted by the type and then dropped. The timeout is
therefore enforced in `src/attachments.ts` (`withIdleTimeout`) as a real **idle** timeout on
the byte stream: 60s with no bytes abandons the download and emits `attachmentFailed` with
the reason, and a slow-but-moving 100 MiB file is not killed by a total deadline.

## A send WhatsApp refused is an error, not a `messageId`

`sendMessage` resolving means the stanza left the socket, not that WhatsApp took it. The
verdict comes back separately as `<ack class="message" error="…">`, and the station now
waits for it: `send` holds for up to `METRO_WHATSAPP_ACK_WAIT_MS` (default 5000, `0` turns
the wait off) and throws instead of returning a message id when the ack carries an error.
`463` is `whatsapp_account_restricted` and names the timelock and the no-retry rule; any
other code is `whatsapp_send_refused`. No ack inside the window is still reported as sent —
the absence of a verdict is not a verdict.

The ack is read straight off the socket (`sock.ws.on('CB:ack,class:message')`,
`src/ack.ts`), **not** from `messages.update`. Baileys emits its own `messages.update` for
the same ack through the buffered event emitter, and a buffer that never flushes eats it:
that is exactly what happened on `a2` (5 activations, 4 flushes), and `messages.update`
carried no evidence of a refused send for the whole session. Baileys 7 adds a 30s watchdog
that auto-flushes a stuck buffer, so the event now arrives late rather than never — late is
still no good for answering an MCP call. `messages.update` is kept as the delivery log and
now carries `messageStubParameters`, so the log line reads `error (463: Your account has
been restricted)` rather than a bare `error`.

## Constraints

Real-account automation violates WhatsApp's ToS and the number can be **permanently
banned** — use a dedicated number, keep volume low, no bulk/status messaging.
Single-writer per account.
