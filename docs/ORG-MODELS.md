# Organization models

Owner decisions (Less, 2026-10-15): the model router and provider setup move from each box's `model.json` to the organization in api.metro.box's Postgres, like connectors. The gateway stays on each box (requests go box to provider directly). Providers kept: OpenRouter, Codex (both sign-in methods), Anthropic API key, Bedrock. Gemini is removed. Claude logins stay on the box only. Each agent uses the organization's default route unless an admin sets an override for that agent.

## Database (`apps/api/drizzle/0014_org_models.sql`, schema in `packages/connectors/src/db/schema.ts`)

- `model_connections`: `id` (11-char id, pk), `owner`, `provider` (`anthropic`, `bedrock`, `openrouter`, `codex`), `label`, `model` (default model, may be empty), `region` (Bedrock), `zdr` (boolean, OpenRouter), `secret` (sealed, see below), `detail` (JSON text, no secret: `{email, plan, method, accountId, signedInAt, refreshedAt}`), `revision` (integer, bumped on every credential change), `import_agent` and `import_id` (nullable, unique together: idempotent import), `created_by`, `created_at`, `updated_at`.
- `model_routes`: `id` (pk), `owner`, `agent` (nullable; null is the organization default; FK to `agents` cascade), `route` (JSON text `{primary: {connection, model}, fallbacks: [{connection, model}]}`), `updated_by`, `updated_at`. Unique: one default per owner (`agent IS NULL`), one row per agent. `connection` is a `model_connections.id` of the same owner, or `local:<claude login id>` (agent routes only: that box's own Claude login), or `local:session` (agent routes only: the login the session itself carries, today's keyless passthrough).
- `model_hosts`: `owner` (pk), `chatgpt_host_id` (`urn:uuid:…`, made once per organization for Codex "Continue with ChatGPT").
- Every read of a route or connection for an agent also matches the agent's current owner. Deleting a connection removes it from every route of its owner: when it was a route's primary, the first remaining fallback becomes the primary, and a route left with nothing is deleted. A route always has a primary (a stored one without it reads with its first fallback promoted).

## Secrets

Sealed with `METRO_CONNECTORS_KEY` (`packages/connectors/src/secrets.ts`), with the additional data `metro-model/v1\n<owner>\n<connection id>` (a connector's sealed value never opens as a model secret and the reverse). Shapes (`ModelSecret`):

- `{kind: 'key', apiKey}` for anthropic, openrouter, bedrock (Bedrock API key).
- `{kind: 'codex', method: 'chatgpt' | 'code', accessToken, refreshToken, expiresAt, clientId?, subject?, accountId?}`.

A refresh token never leaves api.metro.box. Codex tokens are refreshed only by api.metro.box, single flight per connection under a row lock (copy `editConnectorIn`/`lockConnector`), when a delivery finds `expiresAt` within 5 minutes, or on a forced refresh. A refresh records `detail.refreshedAt`. A forced refresh within 60 s of the last token (`refreshedAt` or `signedInAt`) does not refresh and answers the current connection, so a provider that keeps refusing a token cannot make every request refresh it. A refused refresh (invalid grant) marks the connection signed out (`detail.signedOut: true`) and delivery omits its credential.

## Agent routes (signed `MetroAgent`, `AgentAuth.accept`, never from a browser)

`POST /api/agents/models` (empty body) answers the agent's effective setup:

```json
{
  "route": {"primary": {"connection": "abcdefghijk", "model": "openai/gpt-5.2"}, "fallbacks": [{"connection": "local:Xyz12345678", "model": "claude-sonnet-5-5"}]},
  "source": "agent" | "organization" | null,
  "connections": [
    {"id": "abcdefghijk", "provider": "openrouter", "label": "OpenRouter", "model": "openai/gpt-5.2", "region": "", "zdr": true, "revision": 3,
     "account": {"email": null, "plan": null, "method": null},
     "credential": {"apiKey": "sk-or-…"} | {"accessToken": "…", "expiresAt": 1792000000000, "method": "chatgpt", "accountId": null} | null}
  ],
  "chatgptHostId": "urn:uuid:…"
}
```

Only connections the effective route names are sent. `route` is null when neither an override nor a default exists. `credential` is null for a signed-out connection.

`POST /api/agents/models/refresh {connection, revision}`: when `revision` is still current and the token is older than 60 s, force a Codex refresh; answer the same connection object as above (with the new revision, or the current one when nothing was refreshed). 404 for a connection the agent's route does not name.

`POST /api/agents/models/import {connections: [...], route, fallbacks}`: the one-time move of a box's `model.json` v2. Each connection `{id, provider, label, model, region, zdr, apiKey?, codex?}` (codex in the `model.json` shape) becomes a `model_connections` row with `import_agent = <agent>` and `import_id = <old id>` (a repeated import returns the same rows, never duplicates). Gemini and Claude-login connections are not sent. A connection with an API key imports as a key connection, even when it also holds a Claude login. The agent's override route is set from `route` and `fallbacks`, mapping old ids to the new ids, and an Anthropic connection with a Claude login and no key to `local:<id>`; a keyless Anthropic connection (no key, no login) maps to `local:session`. A route primary that maps to nothing gives way to the first fallback, and a route left empty sets no override. A row with no 11-character id or an unknown provider, and every row past the 20th, is skipped and named; the rest imports. The organization limit (100 connections) answers 409 only when the rows that can be imported exceed it. Answers `{ids: {<old>: <new>}, skipped: [{id, reason}]}`; the daemon logs the skipped rows.

## Admin routes on api.metro.box (bearer; writes need the organization admin role, like `/api/connectors`)

- `GET /api/models` answers `{connections: [{id, provider, label, model, region, zdr, account, signedOut, createdAt}], default: route | null, agents: {<agent id>: route}}`. No secret, ever.
- `POST /api/models {provider, label, apiKey, model?, region?, zdr?}` (key providers), `PATCH /api/models/<id> {label?, model?, region?, zdr?, apiKey?}`, `DELETE /api/models/<id>`.
- `PUT /api/models/route {agent: <id> | null, primary, fallbacks}`; `DELETE /api/models/route?agent=<id>` removes an override (no `agent` removes the default). A route needs a primary (400 without it), may only name connections of the organization (and `local:…` for an agent route), and keeps at most 8 fallbacks; a `local:…` step may have an empty model.
- `GET /api/models/<id>/models` answers the provider's model list with the stored credential (moved from the daemon's `provider-models.ts`, `model-lists.ts`, `openrouter.ts` list, codex models list): `{models: [{id, name, price?}]}`, kept one hour per connection.
- Codex sign-in, moved from the daemon (`codex-auth.ts`, `codex-device.ts`, `model-signin.ts`): `POST /api/models/codex/login {connection?}` answers `{authorizeUrl}`; `POST /api/models/codex/callback {url}` finishes it (the 127.0.0.1 paste); `POST /api/models/codex/device {connection?}` and `GET /api/models/codex/device/<id>`. The host id is the organization's `chatgpt_host_id`. A finished sign-in creates the connection or updates the named one (new revision).
- OpenRouter sign-in (`openrouter-login.ts`): `POST /api/models/openrouter/login {connection?}` answers `{authorizeUrl}` with the callback `https://api.metro.box/api/models/openrouter/callback` (open, single-use state), which stores the key and redirects to the page.

## The box

- `apps/daemon/src/gateway/org-models.ts` keeps the delivered setup in memory only: fetched at boot, every 60 s, and on `POST /api/model/sync` (member; the page calls it after a change). The page's sync fetches at most once per 5 s: a call inside that window answers what the box holds (after a fetch already running) and one more fetch follows at the end of the window, so a second change made quickly still arrives. Only a 401 with code `agent_key_missing` clears the copy: it is the one answer api.metro.box gives when the agent key is unknown or its agent was deleted, unenrolled or moved to another organization. Every other failure keeps the last good copy without any expiry: a network error, a 5xx, an answer Metro cannot read, and any other 4xx (a 401 for a clock or a replayed nonce, a 429 from the nonce budgets, a proxy's 403 or 429 page, a 404 or 400 during a rollback). Without an enrolled agent key there is no organization setup: the gateway only serves `local:` routes and the session's own login, or the v2 file below.
- The gateway reads the route and credentials from that copy per request. A provider 401 on Codex calls `/api/agents/models/refresh` once with the revision it used, then retries once (same discipline as connectors).
- When the effective primary model changes, the daemon sends the existing live switch (`switchModel`, `notifications/metro/model`).
- The agent view (`agent-user/view.ts`) keeps writing `<agent home>/.metro/agents/model.json` as `{route, connections: [{id, provider, model}]}` from the effective route (the primary connection's id and the route's model), so `packages/cli` `currentModel` is unchanged. A `local:` primary is written with provider `anthropic`.
- Metro's own `model.json` becomes `{version: 3, claude: [{id, email, plan, savedAt}]}`: only the box's Claude logins. On the first start with an enrolled key, a v2 file is imported (`/api/agents/models/import`); it is rewritten as v3 only once the import was taken and the delivery after it was read, so the box never serves an empty route in between. The file is read again right before that write, so a Claude login saved or removed during the import is kept as it is now. Gemini connections are dropped with a log line. Without an enrolled key, or while the import fails, the v2 file stays untouched.
- While Metro's `model.json` is still v2, the gateway serves it on the box as it did before the move (`model-v2.ts`), whatever the organization delivers: its route (the named connection, else the first one), its fallbacks with a model, the API keys and the Codex tokens. Gemini is skipped. An Anthropic connection with a key is a key connection, one with only a Claude login is `local:<login>`, a keyless one `local:session`. Those Codex tokens are not renewed (the per-box refresh is gone and api.metro.box does not hold them yet): a Codex 401 there answers 403 and logs once per connection. An enrolled box imports within a minute, so this only lasts for a box that is not enrolled or whose import keeps failing.
- Removed from the daemon: Gemini (all files), Codex and OpenRouter sign-in flows, `model-signin.ts`, the write routes of the Model API (add, save, choose, drop, fallbacks, bundle, restore), per-box Codex refresh, the provider model lists except the Claude login list. Kept: the request path (passthrough, Bedrock, OpenRouter, Codex translation, tool search, effort, fallback, usage), Claude logins and their usage probe, `GET /api/model` (status for the page: effective route, chain, usage, served, account per connection, `source`), `GET /api/model/claude-models` for a `local:` route, `POST /api/model/sync`.
- The bundle and `.metro` exports no longer carry a model setup; a restore ignores one.

## The page

- Organization settings get a Models page (like the organization's Connectors): connections (add by key, Codex sign-in, OpenRouter sign-in or key, rename, new key, remove), the default route (model and fallbacks, with the route editor), and the agents with an override.
- The agent's Model page shows the effective route (organization or override) with usage from the box, lets an admin set or clear the override (connections of the organization, plus this box's Claude logins and its session login), and keeps the box's Claude logins section.
- Gemini disappears from the page and the client. A daemon older than the release that ships this answers the Model page with "Update Metro".
