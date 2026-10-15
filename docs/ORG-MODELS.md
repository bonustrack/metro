# Organization models

Owner decisions (Less, 2026-10-15): the model router and provider setup move from each box's `model.json` to the organization in api.metro.box's Postgres, like connectors. The gateway stays on each box (requests go box to provider directly). Providers kept: OpenRouter, Codex (both sign-in methods), Anthropic API key, Bedrock. Gemini is removed. Claude logins stayed on the box at first. Each agent uses the organization's default route unless an admin sets an override for that agent.

Owner decision (Less, 2026-10-16): Claude subscriptions move to the organization like the other model connections, pasted on the Models page (never minted on a box). A Claude subscription is an Anthropic connection holding the long-lived token `claude setup-token` prints (Claude Code's own command, "Set up a long-lived authentication token (requires Claude subscription)"; valid about a year, no refresh). The box Claude logins (`local:<id>`), the session login passthrough (`local:session`) and Metro's `model.json` are gone. No agent route named a `local:` step when this shipped (checked in the database), so nothing was migrated: the box only deletes its leftovers.

## Database (`apps/api/drizzle/0014_org_models.sql`, schema in `packages/connectors/src/db/schema.ts`)

- `model_connections`: `id` (11-char id, pk), `owner`, `provider` (`anthropic`, `bedrock`, `openrouter`, `codex`), `label`, `model` (default model, may be empty), `region` (Bedrock), `zdr` (boolean, OpenRouter), `secret` (sealed, see below), `detail` (JSON text, no secret: `{email, plan, method, accountId, signedInAt, refreshedAt}`), `revision` (integer, bumped on every credential change), `created_by`, `created_at`, `updated_at`. The one-time import's `import_agent` and `import_id` columns, their unique index and check were dropped by `0015_drop_model_import` (2026-10-16), one deploy after the code stopped naming them.
- `model_routes`: `id` (pk), `owner`, `agent` (nullable; null is the organization default; FK to `agents` cascade), `route` (JSON text `{primary: {connection, model}, fallbacks: [{connection, model}]}`), `updated_by`, `updated_at`. Unique: one default per owner (`agent IS NULL`), one row per agent. `connection` is a `model_connections.id` of the same owner. A `local:` step (the box Claude logins before 2026-10-16) is refused with a sentence naming the Claude subscription, and one still stored is dropped when the route is read.
- `model_hosts`: `owner` (pk), `chatgpt_host_id` (`urn:uuid:…`, made once per organization for Codex "Continue with ChatGPT").
- Every read of a route or connection for an agent also matches the agent's current owner. Deleting a connection removes it from every route of its owner: when it was a route's primary, the first remaining fallback becomes the primary, and a route left with nothing is deleted. A route always has a primary (a stored one without it reads with its first fallback promoted).

## Secrets

Sealed with `METRO_CONNECTORS_KEY` (`packages/connectors/src/secrets.ts`), with the additional data `metro-model/v1\n<owner>\n<connection id>` (a connector's sealed value never opens as a model secret and the reverse). Shapes (`ModelSecret`):

- `{kind: 'key', apiKey}` for anthropic, openrouter, bedrock (Bedrock API key).
- `{kind: 'claude', token}` for an anthropic Claude subscription: the token `claude setup-token` prints, `sk-ant-oat01-` then 32 to 512 of `[A-Za-z0-9_-]` (`isClaudeToken` in `@metro-labs/core/claude-token`, checked on the way in and when the secret is opened). Its `detail` holds `{subscription: true, signedInAt}`. It is never refreshed: a new token replaces it. **Before it is kept** (create or replace), api.metro.box makes one free `POST /v1/messages/count_tokens` to Anthropic with `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20` (`claude-haiku-4-5`, one word): a 401 or 403 refuses the save with a 400 sentence, and any other answer or a network error refuses it with a 503 "could not check" sentence, so nothing unverified is saved.
- `{kind: 'codex', method: 'chatgpt' | 'code', accessToken, refreshToken, expiresAt, clientId?, subject?, accountId?}`.

A refresh token never leaves api.metro.box. Codex tokens are refreshed only by api.metro.box, single flight per connection under a row lock (copy `editConnectorIn`/`lockConnector`), when a delivery finds `expiresAt` within 5 minutes, or on a forced refresh. A refresh records `detail.refreshedAt`. A forced refresh within 60 s of the last token (`refreshedAt` or `signedInAt`) does not refresh and answers the current connection, so a provider that keeps refusing a token cannot make every request refresh it. A refused refresh (invalid grant) marks the connection signed out (`detail.signedOut: true`) and delivery omits its credential.

## Agent routes (signed `MetroAgent`, `AgentAuth.accept`, never from a browser)

`POST /api/agents/models` (empty body) answers the agent's effective setup:

```json
{
  "route": {"primary": {"connection": "abcdefghijk", "model": "openai/gpt-5.2"}, "fallbacks": [{"connection": "klmnopqrstu", "model": "claude-sonnet-5-5"}]},
  "source": "agent" | "organization" | null,
  "connections": [
    {"id": "abcdefghijk", "provider": "openrouter", "label": "OpenRouter", "model": "openai/gpt-5.2", "region": "", "zdr": true, "revision": 3,
     "account": {"email": null, "plan": null, "method": null},
     "credential": {"apiKey": "sk-or-…"} | {"claudeToken": "sk-ant-oat01-…"} | {"accessToken": "…", "expiresAt": 1792000000000, "method": "chatgpt", "accountId": null} | null}
  ],
  "chatgptHostId": "urn:uuid:…"
}
```

Only connections the effective route names are sent. `route` is null when neither an override nor a default exists. `credential` is null for a signed-out connection.

`POST /api/agents/models/refresh {connection, revision}`: when `revision` is still current and the token is older than 60 s, force a Codex refresh; answer the same connection object as above (with the new revision, or the current one when nothing was refreshed). 404 for a connection the agent's route does not name.

`POST /api/agents/models/import` (the one-time move of a box's `model.json` version 2) is gone since 2026-10-16: every box had moved with beta.309. It answers 404 now.

## Admin routes on api.metro.box (bearer; writes need the organization admin role, like `/api/connectors`)

- `GET /api/models` answers `{connections: [{id, provider, label, model, region, zdr, account, subscription, signedOut, createdAt}], default: route | null, agents: {<agent id>: route}}`. No secret, ever.
- `POST /api/models {provider, label, apiKey, model?, region?, zdr?}` (key providers), or `{provider: 'anthropic', label, claudeToken}` for a Claude subscription (label `Claude subscription` when empty; `apiKey` and `claudeToken` together, or a token on another provider, is a 400), `PATCH /api/models/<id> {label?, model?, region?, zdr?, apiKey?, claudeToken?}` (a new key or token is a new revision; a key never replaces a token and the reverse), `DELETE /api/models/<id>`.
- `PUT /api/models/route {agent: <id> | null, primary, fallbacks}`; `DELETE /api/models/route?agent=<id>` removes an override (no `agent` removes the default). A route needs a primary (400 without it), may only name connections of the organization, and keeps at most 8 fallbacks; every step names a model.
- `GET /api/models/<id>/models` answers the provider's model list with the stored credential (moved from the daemon's `provider-models.ts`, `model-lists.ts`, `openrouter.ts` list, codex models list): `{models: [{id, name, price?}]}`, kept one hour per connection. A Claude subscription asks Anthropic's `/v1/models` with `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20`, and answers the known Claude list when Anthropic refuses (that answer is not kept).
- Codex sign-in, moved from the daemon (`codex-auth.ts`, `codex-device.ts`, `model-signin.ts`): `POST /api/models/codex/login {connection?}` answers `{authorizeUrl}`; `POST /api/models/codex/callback {url}` finishes it (the 127.0.0.1 paste); `POST /api/models/codex/device {connection?}` and `GET /api/models/codex/device/<id>`. The host id is the organization's `chatgpt_host_id`. A finished sign-in creates the connection or updates the named one (new revision).
- OpenRouter sign-in (`openrouter-login.ts`): `POST /api/models/openrouter/login {connection?}` answers `{authorizeUrl}` with the callback `https://api.metro.box/api/models/openrouter/callback` (open, single-use state), which stores the key and redirects to the page.

## The box

- `apps/daemon/src/gateway/org-models.ts` keeps the delivered setup in memory only: fetched at boot, every 60 s, and on `POST /api/model/sync` (member; the page calls it after a change). The page's sync fetches at most once per 5 s: a call inside that window answers what the box holds (after a fetch already running) and one more fetch follows at the end of the window, so a second change made quickly still arrives. Only a 401 with code `agent_key_missing` clears the copy: it is the one answer api.metro.box gives when the agent key is unknown or its agent was deleted, unenrolled or moved to another organization. Every other failure keeps the last good copy without any expiry: a network error, a 5xx, an answer Metro cannot read, and any other 4xx (a 401 for a clock or a replayed nonce, a 429 from the nonce budgets, a proxy's 403 or 429 page, a 404 or 400 during a rollback). Without an enrolled agent key there is no organization setup, so no model: the gateway answers 503 and the session does not start.
- The gateway reads the route and credentials from that copy per request. A provider 401 on Codex calls `/api/agents/models/refresh` once with the revision it used, then retries once (same discipline as connectors). A Claude subscription is sent as `authorization: Bearer <token>` with the `oauth-2025-04-20` beta and no `x-api-key`; a 401 from Anthropic hands the request to the next model of the chain (the step rests 60 s, logged), and only on the last model is it answered 403 `sign in again on the Models page`, never 401. No route is a 503 naming the Models page.
- When the effective primary model changes, the daemon sends the existing live switch (`switchModel`, `notifications/metro/model`).
- The agent view (`agent-user/view.ts`) keeps writing `<agent home>/.metro/agents/model.json` as `{route, connections: [{id, provider, model}]}` from the effective route (the primary connection's id and the route's model), so `packages/cli` `currentModel` is unchanged. 
- Metro's own `model.json` is gone (2026-10-16). It held only the box's Claude logins in version 3 (`{version: 3, claude: [{id, email, plan, savedAt}]}`) after every box imported its version 2 file with beta.309.
- At every start the daemon deletes what the old model setup wrote (`model-leftovers.ts`, like `connectors/leftovers.ts`): in Metro's agents dir `model.json` and `chatgpt-host.json` (the box's ChatGPT host id for the old per-box Codex sign-in), each with its `.tmp-<pid>` file, exact names and regular files only (by `lstat`); and the agent's `~/.metro/claude-logins` folder of the old box Claude logins, removed as the agent (left alone when the agent user is expected but missing). Never fatal, one info line with the count.
- Getting a token: paste only (owner, 2026-10-16, after review). The admin runs `claude setup-token` on their own computer. The box never runs it: the agent user can write the runner store's `claude` binary, so a compromised agent could copy an organization-wide token or plant its own. The box's Claude sign-in (`claude/login.ts`, `/api/claude/login…`) is gone.
- Removed from the daemon: Gemini (all files), Codex and OpenRouter sign-in flows, `model-signin.ts`, the write routes of the Model API (add, save, choose, drop, fallbacks, bundle, restore), per-box Codex refresh, the provider model lists, and since 2026-10-16 the Claude logins (`claude-logins.ts`, `claude-store.ts`, their folders and `?connection=`), the session login passthrough, the Claude usage probe, `GET /api/model/claude-models` and `DELETE /api/model/claude/<id>`. Kept: the request path (Anthropic with a key or a Claude subscription, Bedrock, OpenRouter, Codex translation, tool search, effort, fallback, usage from the answers' headers), `GET /api/model` (status for the page: effective route, chain, usage, served, account per connection, `source`), `POST /api/model/sync`.
- The bundle and `.metro` exports no longer carry a model setup; a restore ignores one.

## The page

- Organization settings get a Models page (like the organization's Connectors): connections (add by key, a Claude subscription, Codex sign-in, OpenRouter sign-in or key, rename, new key or token, remove), the default route (model and fallbacks, with the route editor), and the agents with an override. Adding Anthropic shows the Claude subscription first: "On your computer, with Claude Code installed, run claude setup-token, sign in, then paste the token here." and a paste field, then the API key form. Sign in again pastes a new token. A note says that replacing or removing a token in Metro does not revoke it at Anthropic, and links to https://claude.ai/settings.
- The agent's Model page shows the effective route (organization or override) with usage from the box, and lets an admin set or clear the override with the organization's connections. The box's Claude logins section and the `local:` choices are gone.
- Gemini disappears from the page and the client. Every box runs beta.309 or later, so the page reads only the beta.309 answer of `GET /api/model` (`route` as the primary's id with `model`, usage keyed by connection id, `claude`) and has no version gate in the model area: `ORG_MODELS_SINCE`, `USAGE_SINCE` and the reading of an older daemon's answer (`passthrough` usage, `claudeLogins`, `signedIn`) are gone (2026-10-16).
