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

Auth state (creds + Signal keys) is **not** stored in the DB — it mutates on every
message. It lives as files under `${METRO_STATE_DIR}/whatsapp/<account>/`
(`~/.cache/metro/whatsapp/<account>/`). On Fly `HOME=/data`, so this sits on the mounted
volume and survives deploys, mirroring the XMTP db3. Losing the volume forces a re-pair.

## Login (once, when the number is provisioned)

```sh
WHATSAPP_PHONE=447700900123 bun packages/whatsapp/scripts/login.ts       # pairing code
# or
bun packages/whatsapp/scripts/login.ts --qr                              # QR
```

Enter the code / scan the QR in WhatsApp → Settings → Linked Devices → Link a Device.
The auth state is written to the account dir on the volume; the running train picks it up.

## Constraints

Real-account automation violates WhatsApp's ToS and the number can be **permanently
banned** — use a dedicated number, keep volume low, no bulk/status messaging.
Single-writer per account.
