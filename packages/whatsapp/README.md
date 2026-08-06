# @metro-labs/whatsapp

WhatsApp station for Metro. Uses a **real WhatsApp account** over the multi-device
Web protocol via [Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys`)
— a WebSocket client, no browser and no Business/Cloud bot API.

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

## Constraints

Real-account automation violates WhatsApp's ToS and the number can be **permanently
banned** — use a dedicated number, keep volume low, no bulk/status messaging.
Single-writer per account.
