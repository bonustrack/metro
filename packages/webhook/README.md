# @metro-labs/webhook

> The Metro **webhook** station: turns inbound HTTP webhooks (GitHub, Intercom, …) into
> Metro events.

Private station package (part of the [Metro monorepo](../../README.md)). It depends only
on `@metro-labs/mcp` and implements the station contract from
`@metro-labs/mcp/stations/*`.

Webhook is the one station that has accounts but **no train**: `hasAccounts` is `true`
and `hasTrain` is `false`, so it exports just the `.` export (`station.ts` →
`webhookStation`) and there is **no `./train`** and no subprocess. The daemon's HTTP
server (in `@metro-labs/mcp`) owns the `/api/webhooks/<id>/<token>` receiver and calls this package's
helpers directly. It exposes no message verbs — it is **inbound-only**, and `send`,
`reply`, `react` and `list_members` all refuse on a webhook line.

## Accounts

An endpoint is a row in the `accounts` table like any other station account: attach one
from the control panel (or `POST /api/agents/<id>/accounts/start` with
`{"station":"webhook"}`) and Metro generates the account id, mints a random webhook id and a
token, and answers with the endpoint url built from those two. `materialize.ts` writes
the rows to `~/.metro/webhook-accounts.json` and the daemon reads them from there — no
train stub is written and no process is spawned.

Because an endpoint is an account, it is **owned by an agent**, and everything that
follows from that applies: its events reach only that agent's MCP session and monitor
tail, and detaching it (`DELETE /api/agents/<id>/accounts/webhook/<account_id>`) makes
the url 404 on the next materialize.

The url stays retrievable from the station's page, since a webhook url you cannot get back
is useless. It is the one station credential an API re-serves, to its owning agent only.

## Delivering to an endpoint

`POST https://<public base>/api/webhooks/<webhook_id>/<token>` with the payload as the
body. The `<webhook_id>` is a random 19-digit id of its own — the account id encodes the
agent it belongs to, and this URL is pasted into other people's systems. The whole URL is the credential: no signature header, nothing else to configure.
Anything that is not an exact token match is a `404`, compared in constant time — wrong
token, missing token, unknown id, an account id presented in place of the webhook id, and a
row carrying no token or no webhook id at all.

`GET` on the same url answers `200` with a readiness line and emits nothing, so it is safe
as a liveness check. Anything else is a `405`.

The route is mounted ahead of the monitor router, which claims all of `/api/*`.

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
- `parseLine` — recognizes `metro://webhook/<path>` lines.

## Env vars

None — the station reads no environment variables. Endpoints and their secrets live in
the `accounts` table.
