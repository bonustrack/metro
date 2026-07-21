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

Auth state (creds + Signal keys) lives in **Postgres**, in the `whatsapp_auth` table
(`account_id`, `category`, `item_id`, `value` jsonb). The train reads and write-throughs
it via the `@metro-labs/mcp/db/whatsapp-auth` adapter (`src/auth-state.ts`,
`usePostgresAuthState`) — `saveCreds` writes immediately, `keys.set` write-throughs each
Baileys batch. The pairing survives deploys and volume loss; no `/data` files are needed.

At boot, `materializeFromDb` runs a one-time import: if `whatsapp_auth` is empty for an
account and a legacy `creds.json` exists under `${METRO_STATE_DIR}/whatsapp/<account>/`, it
loads the creds into the DB (logged). After that the files are dead.

## Login (once, when the number is provisioned)

```sh
WHATSAPP_PHONE=447700900123 bun packages/whatsapp/scripts/login.ts       # pairing code
# or
bun packages/whatsapp/scripts/login.ts --qr                              # QR
```

`DATABASE_URL` must be set — the pairing is written straight to `whatsapp_auth`. Enter the
code / scan the QR in WhatsApp → Settings → Linked Devices → Link a Device; the running
train picks it up on its next connect.

## Constraints

Real-account automation violates WhatsApp's ToS and the number can be **permanently
banned** — use a dedicated number, keep volume low, no bulk/status messaging.
Single-writer per account.
