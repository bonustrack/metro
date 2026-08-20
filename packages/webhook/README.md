# @metro-labs/webhook

> The Metro **webhook** station: turns inbound HTTP webhooks (GitHub, Intercom, …) into
> Metro events.

Private station package (part of the [Metro monorepo](../../README.md)). It depends only
on `@metro-labs/mcp` and implements the station contract from
`@metro-labs/mcp/stations/*`.

Webhook is the one station that has accounts but **no train**: `hasAccounts` is `true`
and `hasTrain` is `false`, so it exports just the `.` export (`station.ts` →
`webhookStation`) and there is **no `./train`** and no subprocess. The daemon's HTTP
server (in `@metro-labs/mcp`) owns the `/wh/<id>` receiver and calls this package's
helpers directly. It exposes no message verbs — it is **inbound-only**, and `send`,
`reply`, `react` and `list_members` all refuse on a webhook line.

## Accounts

An endpoint is a row in the `accounts` table like any other station account: attach one
from the control panel (or `POST /api/agents/<id>/accounts/start` with
`{"station":"webhook"}`) and Metro generates the account id, mints a 32-byte signing
secret, and answers with the endpoint url built from that id. `materialize.ts` writes
the rows to `~/.metro/webhook-accounts.json` and the daemon reads them from there — no
train stub is written and no process is spawned.

Because an endpoint is an account, it is **owned by an agent**, and everything that
follows from that applies: its events reach only that agent's MCP session and monitor
tail, and detaching it (`DELETE /api/agents/<id>/accounts/webhook/<account_id>`) makes
the url 404 on the next materialize.

The signing secret is shown once, at attach time. No API returns it again.

## Delivering to an endpoint

`POST https://<public base>/wh/<account_id>` with the payload as the body. Sign the raw
body with HMAC-SHA256 and send it as `x-hub-signature-256: sha256=<hex>` — the same
scheme GitHub uses, so a GitHub webhook works by pasting the url and the secret into the
repository settings. A wrong or missing signature is a `401` and emits nothing.

`GET /wh/<account_id>` answers `200` with a readiness line and emits nothing, so it is
safe as a liveness check. Anything else is a `405`, and an unknown id is a `404`.

## What the agent is handed

The daemon relays a delivery to the agent's MCP session as a `[webhook received]` note
carrying the pretty-printed body, not just the summary line. The body is capped at 8 KiB
with the dropped size named, and only an allowlist of headers is echoed — a delivery's
`authorization`, `cookie` and `x-hub-signature-256` never reach the agent.

The note ends by saying the line is inbound-only, and a webhook never becomes the line a
tool-approval prompt is relayed to.

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

None — the station reads no environment variables. Endpoints and their secrets live in
the `accounts` table.
