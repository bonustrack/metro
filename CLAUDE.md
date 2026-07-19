# CLAUDE.md

## What Metro is

Metro is a relay that bridges chat networks (XMTP, Telegram, Discord, generic webhooks) to an MCP server. Runs as one always-on Fly process; serves MCP in-process over HTTP; supervises one subprocess ("train") per configured station. Inbound chat messages become MCP events for an agent to act on; the agent's outbound tool calls fan back out to the right network.

## Monorepo layout

Bun workspaces (`bun@1.3.9`): `apps/*`, `packages/*`.

- `apps/mcp` — the core. Package `@metro-labs/mcp`, bin `metro-daemon` → `./dist/server.js`. Source dirs:
  - `src/mcp/` — generic MCP core: server, tool dispatch, the `str()` helper (`str.ts`). No per-channel transport logic.
  - `src/channels/` — Channel transport: the `InboundRelay` (`inbound.ts`) that turns bus events into `notifications/claude/channel` MCP notifications. Depends on core (`mcp/str.js`), not vice-versa.
  - `src/monitor/` — the lightweight live Monitor transport (`api.ts`): SSE tail + call/health endpoints.
  - `src/daemon/` — boot, HTTP server, tunnel/endpoints, train supervisor, logging, errors, secure-fs, protocol, the in-process event bus.
  - `src/stations/` — station registry, types, runtime, account-store, attachments, lines, messaging-normalize.
- `packages/*` — five station packages: `@metro-labs/xmtp`, `@metro-labs/telegram`, `@metro-labs/telegram-user`, `@metro-labs/discord`, `@metro-labs/webhook`.

Flow: inbound network message → station → in-process bus → MCP event for the agent. Outbound: agent MCP tool call → station verb → network. The daemon hosts both the MCP server and the stations in one process; the bus connects them.

## Commands / the gate

- `bun install` — install. CI and Docker use `bun install --frozen-lockfile`; always commit `bun.lock` changes or CI/deploy breaks.
- Local run: `bun apps/mcp/src/server.ts` (`server.ts` is just `import './daemon/boot.js'`). Prod and `start` run TS from source — `dist/` is built only by the gate's `build` task and is not used at runtime.
- The gate: `build` + `test` run through turbo; `typecheck`, `lint` (eslint), `knip`, `madge` run through `stage` (`@stage-labs/config`). Run the full set (`bun run build && bun run typecheck && bun run lint && bun run knip && bun run madge && bun run test`) before any PR; gate must be green.
- Single package: run the same scripts inside the package (e.g. `bun --filter @metro-labs/mcp test`).
- Tests: `apps/mcp` test script is `tsc --noEmit && bun test test/`; the real command runs with `METRO_STATE_DIR="$(mktemp -d …)"`. The turbo `test` task `dependsOn ["^build"]` so a core (`apps/mcp/src`) edit invalidates the station packages' cached test results. Run the full `bun test` suite — don't assert an exact test count.
- madge runs via `stage madge` (`@stage-labs/config`), configured through `stage.config.js`.

## Conventions (strict `@stage-labs/config` preset — HARD constraints)

- No comments in source. None. Don't add explanatory comments.
- No escape hatches: no `eslint-disable`, no `@ts-ignore`/`@ts-expect-error`, no `any` casts to dodge types.
- Size caps enforced by lint: `max-lines` per file (counts blanks + comments) and function-length limits. Split files instead of suppressing.
- tsconfig is strict; ESM. Import specifiers MUST carry explicit `.js` extensions (`./tunnel.js`, not `./tunnel`).
- Errors: throw real errors; surface messages via the shared `errMsg` helper and `TrainError` (`@metro-labs/mcp/train-error`). Don't swallow.
- Logging via the shared `log` (`@metro-labs/mcp/log`) — not `console`.
- Imports from core use the exports map, e.g. `@metro-labs/mcp/log`, `/train-error`, `/secure-fs`, `/events`, `/lines`, `/endpoints`, `/trains/protocol`, `/stations/types`, `/stations/station-runtime`, `/stations/account-store`, `/stations/attachments`, `/stations/messaging-normalize`. Station packages: `.` → `src/station.ts` (station def), `./train` → `src/index.ts` (train entry).

## Architecture notes

- In-process bus (`src/daemon/events.ts`): inbound flows station → bus → MCP event in one process. It is a bus, not a journal — no on-disk persistence/history. It keeps a small bounded in-memory ring buffer (`BUS_BUFFER_MAX = 500`) keyed by a monotonic `busSeq`; the Channel relay (`src/channels/relay.ts`) tracks the highest contiguously-delivered `busSeq` and replays missed events on transport rebind so the Claude channel does not drop messages across reconnects. Bounded + in-memory only — do NOT add an on-disk journal/history.
- Static seam: stations are wired through the registry in `src/stations/`; core dispatches generically over station defs (verbs/attachment modes), no per-network branching in core.
- Tolerated package cycle: there is a known dependency cycle between core and station packages. It is intentional and tolerated — do NOT "fix" it; madge is configured around it.
- Four out-of-process trains (XMTP, Telegram, Telegram-user, Discord) + webhook handled in-core (no subprocess; `hasAccounts: false`). The telegram-user train only spawns when its session is configured.
- Permission replies (human-in-the-loop): a pending MCP `permission_request` is relayed to chat as `yes <request_id>` / `no <request_id>`; `inbound.ts` matches the chat reply with `PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`. The 5-char-code format is a contract with the relayed prompt — never change one side only.
- REMOVED / don't resurrect: `history.jsonl`, on-disk journal/outbox, the Codex integration (dropped in #16). Don't reintroduce these. The old read-only HTTP "Monitor dashboard" (ring-buffer/backlog replay, `/api/state`, claims/owner-mode filtering) was removed in #40 — do NOT bring those parts back. A deliberately-scoped **lightweight Monitor transport** was reintroduced (`daemon/monitor-api.ts`): live-only `GET /api/tail` SSE (no replay), `POST /api/call/:train/:action`, `GET /api/health`, gated by the shared `METRO_MCP_HTTP_TOKEN` (same `?token=`/Bearer as the MCP/Channel endpoint; unset → 404), mounted before the MCP auth gate. Keep it minimal — no history/ring buffer/claims.

## Stations

| Station | Attachment | Verbs | Allowlist envs | Notes |
|---|---|---|---|---|
| xmtp | out-of-process train (`./train`) | message: `send`/`reply`/`react`/`unreact`/`read`; push: `register-push`/`test-push`/`unregister-push`/`disable-push`; + mutating verbs | `XMTP_ONLY_ACCOUNTS`, `XMTP_ACCOUNTS` | Production XMTP/MLS net. DB `~/.metro/xmtp-production-<id>.db3`, env `production`. Single-writer (see Deploy). Use a separate `MNEMONIC` for dev. |
| telegram | out-of-process train | message: `send`/`reply`/`react`/`unreact`/`edit`/`delete` (NO `read`); + six `send_*` verbs | `TELEGRAM_ONLY_ACCOUNTS`, `TELEGRAM_ACCOUNTS` | |
| telegram-user | out-of-process train (`./train`) | message: `send`/`reply`/`react`/`unreact`/`edit`/`delete`/`read` | `TELEGRAM_USER_ONLY_ACCOUNTS`, `TELEGRAM_USER_ACCOUNTS` | Telegram **user account** (MTProto via `@mtcute/bun`), not the bot API. Env `TELEGRAM_USER_API_ID`/`API_HASH`/`SESSION`/`ACCOUNTS`/`ONLY_ACCOUNTS`. Dormant until a session is set (the entrypoint only writes the train stub when `TELEGRAM_USER_SESSION`/`_ACCOUNTS` is configured). Constraints: Telegram ToS / ban risk; `TELEGRAM_USER_SESSION` is a full-account secret; single-writer per account. |
| discord | out-of-process train | message: `send`/`reply`/`react`/`unreact`/`read`/…; + thread/pin/typing/presence/voice verbs | `DISCORD_ONLY_ACCOUNTS`, `DISCORD_ACCOUNTS` | Voice via `@discordjs/voice`/`prism-media`. |
| webhook | in-core (`.` only, `hasAccounts: false`) | `webhookEntry` / `verifyWebhookSig` | — | Constant-time HMAC-SHA256: `createHmac('sha256')` + `timingSafeEqual`, `sha256=` prefix. |

Allowlists resolve via account-store `allowlistEnv` (`_ONLY_ACCOUNTS` restricts; `_ACCOUNTS` configures).

## Deploy & Ops

- Auto-deploy on `main`: merging to `main` deploys to Fly. Don't merge unfinished work.
- Fly app `metro`, region `iad` (`fly.toml`). `auto_stop_machines=false`, `auto_start_machines=false`, `min_machines_running=1`, `shared-cpu-1x`/1gb, mount `metro_data`→`/data`. Env: `HOME=/data`, `METRO_TRAINS_DIR=/app/trains`, `METRO_HTTP_HOST=0.0.0.0`, `METRO_LOG_LEVEL=info`.
- Single HTTP port: `internal_port=8420`. Port is `webhookPort()` = `Number(process.env.METRO_WEBHOOK_PORT) || 8420` — 8420 is an overridable default, not a constant. Serves MCP, webhooks, and health.
- /health coupling: `daemon/http.ts` serves `GET /health` and `/healthz` — 200, unauthenticated, checked BEFORE the MCP auth gate. Body is `{status:'ok',version,uptime}` (uptime = `Math.round(process.uptime())` seconds; version = `npm_package_version ?? '0.1.0-beta.15'`). Fly health-check hits `GET /health` (interval 30s, timeout 5s, grace 45s). Breaking/gating this route → machine marked unhealthy → outage. A test guards it; keep it passing.
- Single-writer XMTP: only ONE instance may write the XMTP/MLS inbox. A second writer burns the 10-install / 256-update budget (exhaustion = permanently dead inbox). This is why `min_machines_running=1` and machines never auto-stop/start. Never run a second prod writer.
- Entrypoint (Docker): mkdir state, symlink `node_modules`, `rm -f .tail-lock`, write per-configured-station stubs, then `exec bun /app/apps/mcp/src/server.ts`.
- MCP reconnect reality: the MCP channel GET SSE stream is kept open by a 15s SSE-comment keepalive in `src/mcp/raw-get-stream.ts`. On reconnect the Channel relay replays events from the bounded in-memory ring buffer (busSeq > last contiguously-delivered) — recovery is best-effort and bounded to the last `BUS_BUFFER_MAX` events, not guaranteed across a long disconnect or a buffer overflow.

## Database / multi-agent (Postgres + Drizzle)

- DB is the ONLY runtime account source — nothing reads station secrets from the environment. Three tables in `src/db/schema.ts`, NO foreign-key constraints (accounts/keys reference their agent by a plain `agent_id` int): `agents` (`id` serial PK, `name` unique), `accounts` (`agent_id`, `station` enum, `account_id`, jsonb `config`; PK (`station`,`account_id`)), `keys` (`agent_id`, `name`, `key`; PK (`agent_id`,`name`); per-agent API keys). Drizzle-kit config `apps/mcp/drizzle.config.ts`, generated SQL in `apps/mcp/drizzle/`. Deps live ONLY in `apps/mcp` (`drizzle-orm`, `postgres`, dev `drizzle-kit`) — station packages never import the DB.
- Loading model (deliberately small, subprocess-safe): `db/materialize.ts` is the single DB module — it opens the client (`db/client.ts`), reads agents+accounts, and WRITES the per-station account files (`~/.metro/<station>-accounts.json`, via `writeSecure` 0600) + the train stubs. It runs once at boot (`boot.ts`, before `supervisor.start()`). The station trains are UNCHANGED — they still read those files through the account-store's file path; no pg in the trains. `materializeFromDb()` throws on missing `DATABASE_URL` or empty DB — one path, fails loudly. The docker entrypoint no longer generates stubs; materialize does.
- `METRO_AGENT` (name) restricts a daemon to one agent; unset loads all. `applyAgentKey` sets `METRO_MCP_HTTP_TOKEN` from the single agent's first key row. Inbound is tagged with the owning agent via `db/agent-map.ts` — materialize sets the in-memory map (same process as the tagger), `agentForLine` in `http.ts` sets `MetroEvent.agent`. DEFERRED: multiplexing multiple agents into separate isolated MCP sessions with per-session inbound filtering — today run one daemon per agent for full isolation.
- xmtp account config is `{ mnemonic, derive }` OR `{ privateKey }` (`packages/xmtp/src/accounts.ts`) — the identity secret lives in the DB, no env `MNEMONIC` path. The DB is populated directly by the operator; `drizzle.config.ts` is outside `src/**` and auto-detected by knip's drizzle plugin.
- DO deploy: set up manually (no App Platform spec committed) — Droplet + DO Volume at `/data` for XMTP's persistent single-writer MLS DBs. `fly.toml` kept.

## Working discipline

- Verify, then act: confirm claims against the code (rg/Read) before changing or asserting. Most "obvious" facts here have load-bearing exceptions.
- Don't flag code as dead/unused without an `rg` search proving zero references across the workspace (including the exports map and station registry).
- Gate-green: full turbo gate must pass before you propose a PR.
- PR/merge: branch off `main`, open a PR, land via PR. Merging to `main` auto-deploys. For stacked PRs, beware `--delete-branch` on merge deleting the base of a dependent PR.
