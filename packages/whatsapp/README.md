# @metro-labs/whatsapp

WhatsApp station for Metro. Uses a **real WhatsApp account** over the multi-device
Web protocol via [Baileys](https://github.com/WhiskeySockets/Baileys) (`baileys`, the
package `@whiskeysockets/baileys` was renamed to) — a WebSocket client, no browser and no
Business/Cloud bot API.

Config (`accounts` row `config` jsonb): `{ "phone": "<E.164 digits>" }`, optional `owner`.
`account_id` convention: `w0`. Lines are `metro://whatsapp/<account>/<jid>` where `<jid>`
is a WhatsApp jid (`<number>@s.whatsapp.net` for DMs, `<id>@g.us` for groups).

## v1 scope

`send` / `reply` / `react` / `unreact` / `edit` / `delete`. Media, groups, and history
(`read`) are deferred — Baileys cannot fetch arbitrary server-side history, so `read`
is intentionally not advertised.

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

### The one thing that IS written to disk: the trusted-contact token cache

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
