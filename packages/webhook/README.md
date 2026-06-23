# @metro-labs/webhook

> The Metro **webhook** station: turns inbound HTTP webhooks (GitHub, Intercom, …) into
> Metro events.

Private station package (part of the [Metro monorepo](../../README.md)). It depends only
on `@metro-labs/mcp` and implements the station contract from
`@metro-labs/mcp/stations/*`.

Unlike the other stations, webhook is **descriptor-only**: it exports just the `.` export
(`station.ts` → `webhookStation`) — there is **no `./train`** and no subprocess. The
dispatcher's HTTP server (in `@metro-labs/mcp`) owns the `/wh/<id>` receiver and calls
this package's helpers directly. `hasAccounts` is `false` and it exposes no message
verbs — it is **inbound-only**.

## Capabilities

- `webhookEntry(...)` builds a `MetroEvent` from an incoming request on
  `metro://webhook/<id>` — deriving a message id from `x-github-delivery` /
  `x-request-id`, a summary line from `x-github-event` / `x-intercom-topic`, and
  carrying the full `{ headers, body }` as the payload. Routes to the bound session when
  the endpoint has one.
- `verifyWebhookSig(secret, raw, header)` — constant-time HMAC-SHA256 signature check
  (`sha256=…`) for providers that sign their deliveries.
- `parseLine` — recognizes `metro://webhook/<path>` lines.

## Env vars

None — the station reads no environment variables. Endpoints/secrets are configured
through the daemon's tunnel/endpoint config, not via env.
