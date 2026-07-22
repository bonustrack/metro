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

## Constraints

Real-account automation violates WhatsApp's ToS and the number can be **permanently
banned** — use a dedicated number, keep volume low, no bulk/status messaging.
Single-writer per account.
