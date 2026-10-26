# gateway.metro.box (plan, 2026-10-26)

Status: proposal, nothing built. It follows the path connectors took to mcp.metro.box
(`docs/MCP-SERVER.md`): one central service, credentials that never reach a box, one
place that records what happened.

## Goal

1. Every model request of every agent goes through one service, `https://gateway.metro.box`,
   which routes it to the organization's providers with the model order of the agent.
   There is one path: the box has no router and no direct way to a provider.
2. Metro knows the usage of every request (tokens, model, provider, time, outcome) in one
   table, for the page's charts and for limits later.
3. Any other service of the organization (first: Stage's dashboard,
   https://github.com/stagelabs/dashboard) can use the organization's model setup with an
   access key, the way any MCP client can use its connectors today.
4. Metro never logs or stores what was asked or answered. Only usage.

## What exists today

- The router lives in each box's daemon (`apps/daemon/src/gateway/`, about 3,400 lines):
  Anthropic (key or Claude subscription), Routeway, OpenRouter, Bedrock and Codex (both
  sign-ins), backups with holds, effort per thread, compaction at low effort, tool search
  fitting, thinking adaptation, usage from headers and stream frames.
- The organization setup is delivered to each box with its credentials
  (`POST /api/agents/models`), except Codex refresh tokens, which stay on api.metro.box.
- Usage is in each box's memory and is lost at restart. The page reads it from the box
  (`GET /api/model`).
- The router is almost self-contained: it reads the setup through one function
  (`GatewayDeps.setup`) and checks the agent key in one place. Its state (holds, usage,
  learned model quirks, last served) is module-level, keyed by connection id. Outside the
  folder, the daemon uses it only in `routes/` (mount), `boot/` (start, usage watch),
  `claude/session.ts` and `agent-user/view.ts` (the effective model).

## Accounts on a central server (owner's decision, 2026-10-26)

Every account kind runs on gateway.metro.box, subscriptions included, so the code has one
path. The owner does not use subscriptions through it yet. For the record, as of
2026-10-25:

- Anthropic's terms (https://code.claude.com/docs/en/legal-and-compliance) do not permit "to
  route requests through Free, Pro, or Max plan credentials on behalf of their users" and
  say "developers may not collect, store, or intermediate Claude.ai credentials or session
  tokens". API keys are fine.
- OpenAI opened ChatGPT plans to other apps at DevDay (2026-09-29); commercial apps are a
  limited partner preview (https://openai.com/form/sign-in-with-chatgpt-interest/). The
  Codex code sign-in is not part of it.

Applying to OpenAI's partner preview can run in parallel with this plan.

## Shape

```
Claude Code on the box
  -> daemon /gateway   (x-metro-key, box only, Claude Code's settings unchanged)
  -> gateway.metro.box (the box's agent token)
  -> provider

Dashboard (or any service) with an access key
  -> gateway.metro.box -> provider
```

- **The router lives in `packages/inference`**, run by `apps/gateway`; after phase 3 the
  daemon no longer uses it. Its module state becomes a
  `Router` instance, so one process serves many organizations. Holds and usage windows are
  per connection, so they are shared by every agent of an organization.
- **The daemon's `/gateway` becomes a relay**, a pipe with no provider logic: it checks the
  agent key (box only, `cameThroughProxy`), streams the body up and the answer down, passes
  the Claude Code hint headers (`x-claude-code-*`), and closes the upstream when Claude Code
  goes away (Bun 1.4.0 or later, see the leak note in CLAUDE.md). When gateway.metro.box
  cannot be reached, Claude Code gets a 503 with a sentence and retries, as it does today
  for "no route". There is no local path to fall back to.
- **Why the daemon still relays** instead of Claude Code calling gateway.metro.box itself:
  the credential would then be in the agent's environment, and the agent could copy it and
  use the organization's models anywhere. The agent key stays box-only and the box's agent
  token stays in Metro's folder, exactly like the MCP token today.
- **What the box still knows**: the route without any credential (connection ids, models,
  effort), delivered by api.metro.box as today. It needs it for the live model switch
  (`notifications/metro/model`) and for the agent view's `model.json` (`currentModel`).

## gateway.metro.box

`apps/gateway` (`@metro-labs/gateway`), Fly app `metro-gateway`, region `iad` only at
first (owner's decision, 2026-10-26: measure, then decide on `fra`), two always-on machines, deployed by its own workflow like `mcp.yml`. Env: `DATABASE_URL`,
`METRO_CONNECTORS_KEY` (the same values as api.metro.box and mcp.metro.box). It imports
`core`, `http` and `connectors`, never the daemon.

### Routes

| Route | Auth | Note |
| --- | --- | --- |
| `GET /health` | none | `{status, version, uptime}`. |
| `POST /v1/messages` | agent token or access key | Anthropic Messages, streamed or not. |
| `POST /v1/messages/count_tokens` | same | |
| `GET /v1/models` | same | The model names below. |

The key is read from `x-api-key` or `Authorization: Bearer`, so the official SDKs work
with only a base URL:

```ts
import Anthropic from '@anthropic-ai/sdk';
const ai = new Anthropic({ baseURL: 'https://gateway.metro.box', apiKey: process.env.METRO_KEY });
await ai.messages.create({ model: 'metro', max_tokens: 1024, messages: [{ role: 'user', content: 'Hello' }] });
```

### Credentials

- **A box** sends its agent token: the MCP token it already has (`agent_keys.mcp_token_hash`,
  accepted only for an agent with a host), so enrollment, re-registration after a 401 and
  rotation work unchanged. Docs then call it the agent token.
- **An access key** (`agent_tokens`) gets scopes, one key for both (owner's decision,
  2026-10-26): a new column `scopes` (`connectors`, `gateway`), `{connectors}` for every
  existing key (no key gains power silently), and the page offers Connectors and Gateway
  when a key is created; an admin can change a key's scopes later. mcp.metro.box refuses a
  key without `connectors`, gateway.metro.box one without `gateway`. A key uses the model order of its agent: an agent without a
  server named "Dashboard" with its own route override is how a service gets its own setup
  and its own usage line.
- **Provider credentials** are opened on gateway.metro.box only (`METRO_CONNECTORS_KEY`,
  the sealed `model_connections.secret`), per request from a 10 s cache. They never reach a
  box.
- **Codex refresh moves here**: the single-flight refresh under the row lock moves from
  `apps/api` to `packages/connectors`, and gateway.metro.box calls it before a token
  expires and once after a 401, as the box does through api.metro.box today. The
  organization's ChatGPT host id (`model_hosts`) and the Codex version check move with it.

### Model names

- **Box requests** keep today's rules: the lane from the hint headers (main or workers), a
  haiku chore passes as asked on a Claude step, compaction at low effort.
- **An access key** asks for `metro` (the agent's main model order, with the route's main
  effort) or `metro-workers` (the workers order, the main one when none, with the workers
  effort). Anything else is a 400 that names these two. No route answers 503 with a
  sentence naming the Models page.
- **An access key may use every account of the model order**, subscriptions included
  (owner's decision, 2026-10-26), like a box.

### Usage, never content

- **Table `model_calls`** (migration in `apps/api`, like `mcp_calls`): `id`, `owner`,
  `agent`, `agent_name`, `origin` (`box`, `key`), `token` (the access key id or null),
  `lane` (`main`, `workers`), `kind` (`main`, `subagent`, `compaction`, `chore`, `external`),
  `connection`, `provider`, `model`, `attempt` (0 for the main model, 1 for the first
  backup, …), `outcome` (`ok`, `rate_limited`, `refused`, `provider_error`, `cancelled`,
  `no_route`), `status`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_write_5m_tokens`, `cache_write_1h_tokens`, `cost_micros` (null when unknown), `ms`,
  `first_token_ms`, `at`. One row per attempt, so a 429 hand-over to a backup is visible.
- **Counting reads only usage frames**: `message_start`, `message_delta` and `error`, plus
  the rate limit headers (and the Responses usage event for Codex). Content deltas pass
  through and are never kept.
- **Writes are batched** (every 2 s or 100 rows), never awaited by a request; a missing table
  is logged once and calls go on (the `mcp_calls` pattern).
- **Retention**: every row is kept for good, like `mcp_calls` (owner's decision,
  2026-10-26). A busy agent makes a few thousand requests a day, so the table grows by about
  1 GB per busy agent per year at the `mcp_calls` size; the indexes are `(owner, at desc,
  id desc)` and `(owner, connection, at desc)`, and the charts read time ranges only.
- **Hard privacy rules**, each with a test: no request or response body in a log, a row or
  an error; no tool names or system prompts; a provider's error message goes back to the
  caller as it came but is never logged centrally (only the status and the provider's error
  type); bodies live in memory only for the request (the 400 retry included). One test sends
  a canary string in a prompt and in a scripted answer and checks it appears in no log line
  and no table.
- **Spend, from day one** (owner's decision, 2026-10-26): `cost_micros` on every row.
  OpenRouter's own cost when its answer carries one; Routeway from its model list's
  `pricing` (already read for the picker); Anthropic and Bedrock from a price table in
  `apps/gateway` (input, output, cache read, 5-minute and 1-hour cache write, per model),
  with a test that fails when a model the pickers offer has no price. A Claude subscription
  or a Codex plan has no per-token price: its rows keep tokens and a null cost, and the page
  says the plan covers it. Tokens are always exact; a cost is only as right as the table.

### Shared state

- Holds (a model above 95% of a window, a 429 until its reset) are per connection and model.
  Each machine keeps them in memory and writes changed windows to a small table
  `model_windows` (owner, connection, window, used, resets at), at most every 10 s per
  connection; machines read it every 15 s. The page reads the same table.
- The free usage checks (OpenRouter's `/api/v1/key` every 5 minutes) run here, once per
  connection, instead of on every box.
- Learned model quirks (thinking off refused, cache TTL refused) stay in memory per machine.
- The setup of an agent (route plus opened credentials) is read from Postgres and cached
  10 s per agent; a change on the Models page applies within 10 s.

### Transport

- Cloudflare DNS for `gateway.metro.box` is DNS only (grey cloud): proxied, a stream that
  sends nothing for 125 s is cut with a 524, answers can be buffered, and Cloudflare replaces
  502 and 504 bodies (the api already met this, see Deploy and operations).
- Fly: idle timeout 60 s, reset by any byte, so pings every 15 s on every stream; the proxy
  also cuts a stream after about 30 s when the client stops reading (2026-10-08), which must
  end as a clean error for Claude Code. `soft_limit` and `hard_limit` by requests, not
  connections (the default 20 connections would queue streams). Bodies over 10 MB lose
  Fly's retry and pay about 3 s; rare for Claude Code.
- Latency: one more hop. A box in Europe adds about 80 to 100 ms to the first token through
  `iad`. Measure with `bun run sdk-runner-check` through gateway.metro.box before deciding on
  a second region (`fra`).
- Bandwidth: prompts flow in (free on Fly), answers flow out ($0.02/GB in North America and
  Europe), so a few dollars a month at most.

## What leaves the daemon

`apps/daemon/src/gateway/` is replaced by the relay (one file) and the route delivery
without credentials. Gone from the box: every provider path (`forward`, `bedrock`,
`eventstream`, `codex*`, `routeway`, `openrouter`, `subscription`), `fallback`, `effort`,
`tool-search`, `cache-ttl`, `usage`, `usage-refresh`, `served`, `failures`, and the box's
`GET /api/model` usage, chain and last served (the page reads them from api.metro.box).
The router's tests, still in `apps/daemon/test` after 1a, move to `packages/inference/test`.

## Phases

Each phase ships alone and leaves every box working. The page ships before boxes update,
and boxes update one by one, so api.metro.box keeps delivering credentials to a daemon
older than phase 3 until none is left. That is the only overlap; no box ever has two paths.

1. **gateway.metro.box**, in four pull requests:
   - 1a: the router moves from `apps/daemon/src/gateway/` to `packages/inference`
     (`@metro-labs/inference`, imports only `core` and `http`), its module state into a
     `Router` instance; the daemon uses the package, with no change in behavior.
   - 1b: the migration (`model_calls`, `model_windows`, `agent_tokens.scopes`) and their
     store functions in `packages/connectors`; mcp.metro.box refuses a key without
     `connectors`.
   - 1c: not needed: the Codex refresh was already shared (`@metro-labs/connectors/model-refresh`).
   - 1d: `apps/gateway` (auth, setup from Postgres, usage and cost rows, the price table),
     the Fly config and a deploy workflow started by hand. The router reports each attempt
     to an `onCall` hook (`attempts.ts`), and access keys name `metro` or `metro-workers`.
     Usage windows are saved but not read back yet, so holds stay per machine; reading them
     back is a follow-up.
   - Brought up 2026-10-25: Fly app `metro-gateway` (shared IPv4 `66.241.125.125`, its own
     IPv6), secrets copied from `metro-mcp` (same fingerprints), first deploy from a local
     `fly deploy`, certificate for gateway.metro.box (DNS only CNAME to
     `metro-gateway.fly.dev`). The workflow deploys on merges with `FLY_GATEWAY_API_TOKEN`, a
     deploy token for that app only. Access keys with the `gateway`
     scope work from here: the dashboard can start. Tests: the gateway tests, a PGlite e2e
     like `apps/mcp`, the canary test.
2. **The page** (shipped 2026-10-26: access key scopes #385, the Gateway name #386, the Usage page and the agent's usage section): Models renamed Gateway everywhere, the scopes on access keys, a docs page for services, and usage and spend
   from api.metro.box on the Models page (per account and per agent), the agent's Model page and
   Home, with the connector charts' pieces (`CallChart`, tiles). A box before phase 3 still
   answers `GET /api/model`, so the page reads both until phase 4.
3. **Boxes through the gateway** (relay built 2026-10-26, `apps/daemon/src/gateway/relay.ts`, in the release after beta.321): a daemon release replaces its use of
   `packages/inference` with the relay
   (`METRO_GATEWAY_URL`, default `https://gateway.metro.box`; tests point it at a stand-in).
   Check on one box with `sdk-runner-check` and `sdk-runner-model`, then publish.
4. **Clean up**, in two steps (2026-10-26): first a release (beta.323) where a relaying box judges readiness without credentials and the delivery carries each connection's `auth` and `signedOut`, since a beta.322 box refuses to start its session without credentials; then, once every box runs it, the delivery
   (`POST /api/agents/models`) stops sending credentials, `/api/agents/models/refresh` and
   the page's reading of the box's usage go, and the CLAUDE.md sections on the gateway and
   organization models are rewritten around gateway.metro.box.
5. **Later, if needed**: an OpenAI-compatible `/v1/chat/completions` (for tools that only
   speak OpenAI), per-key budgets and rate limits, a second region.

## Decisions (owner, 2026-10-26)

- One path: everything through gateway.metro.box, subscriptions included in the code.
- gateway.metro.box has no page and no API for the page: it answers model requests and
  writes usage rows. Usage, spend, access keys and the model setup are shown and managed on
  metro.box, which reads them through api.metro.box from the same database, as the Live
  activity feed reads `mcp_calls`.
- Access keys may use every account, subscriptions included.
- One access key with scopes (Connectors, Gateway).
- Every usage row kept for good.
- Spend in dollars from day one.
- `iad` only at first; measure, then decide on `fra`.
- The page calls it Gateway everywhere, not Models: the rail section, the organization
  page, the agent's Settings page and the access key scope (code and wire keep `model`
  names where they exist; the new scope is `gateway`).

## Risks

- **One point of failure**: today a box fails alone; with this, an outage of
  gateway.metro.box stops every agent. Two machines, health checks and an alert.
- **One place holds every key**: gateway.metro.box can open every organization's model
  secrets, as api.metro.box and mcp.metro.box already can with the same key.
- **Provider view**: every organization's traffic now comes from Fly's addresses; abuse
  systems may treat it as one sender. API keys are made for this; plan accounts are where
  a provider is most likely to act.
- **Privacy promise**: customers lose "nothing leaves my box except to the provider".
  Prompts cross Metro's servers in transit; the privacy policy and any customer agreement
  must say so before phase 3.
