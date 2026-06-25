# CLAUDE.md

## What Metro is

Metro is a relay that bridges chat networks (XMTP, Telegram, Discord, generic webhooks) to an MCP server. Runs as one always-on Fly process; serves MCP in-process over HTTP; supervises one subprocess ("train") per configured station. Inbound chat messages become MCP events for an agent to act on; the agent's outbound tool calls fan back out to the right network.

## Monorepo layout

Bun workspaces (`bun@1.3.9`): `apps/*`, `packages/*`.

- `apps/mcp` — the core. Package `@metro-labs/mcp`, bin `metro-daemon` → `./dist/server.js`. Three source dirs:
  - `src/mcp/` — MCP server, tool dispatch, inbound event handling, keepalive.
  - `src/daemon/` — boot, HTTP server, tunnel/endpoints, train supervisor, logging, errors, secure-fs, protocol, the in-process event bus.
  - `src/stations/` — station registry, types, runtime, account-store, attachments, lines, messaging-normalize.
- `packages/*` — five station packages: `@metro-labs/xmtp`, `@metro-labs/telegram`, `@metro-labs/telegram-user`, `@metro-labs/discord`, `@metro-labs/webhook`.

Flow: inbound network message → station → in-process bus → MCP event for the agent. Outbound: agent MCP tool call → station verb → network. The daemon hosts both the MCP server and the stations in one process; the bus connects them.

## Commands / the gate

- `bun install` — install. CI and Docker use `bun install --frozen-lockfile`; always commit `bun.lock` changes or CI/deploy breaks.
- Local run: `bun apps/mcp/src/server.ts` (`server.ts` is just `import './daemon/boot.js'`). Prod and `start` run TS from source — `dist/` is built only by the gate's `build` task and is not used at runtime.
- The gate (turbo): `build` (tsc), `typecheck`, `lint` (eslint), `knip`, `madge`, `test`. Run the full set before any PR; gate must be green.
- Single package: run the same scripts inside the package (e.g. `bun --filter @metro-labs/mcp test`).
- Tests: `apps/mcp` test script is `tsc --noEmit && bun test test/`; the real command runs with `METRO_STATE_DIR="$(mktemp -d …)"`. Run the full `bun test` suite — don't assert an exact test count.
- madge runs per-package via each package's `scripts/madge.mjs`.

## Conventions (strict `@stage-labs/config` preset — HARD constraints)

- No comments in source. None. Don't add explanatory comments.
- No escape hatches: no `eslint-disable`, no `@ts-ignore`/`@ts-expect-error`, no `any` casts to dodge types.
- Size caps enforced by lint: `max-lines` per file (counts blanks + comments) and function-length limits. Split files instead of suppressing.
- tsconfig is strict; ESM. Import specifiers MUST carry explicit `.js` extensions (`./tunnel.js`, not `./tunnel`).
- Errors: throw real errors; surface messages via the shared `errMsg` helper and `TrainError` (`@metro-labs/mcp/train-error`). Don't swallow.
- Logging via the shared `log` (`@metro-labs/mcp/log`) — not `console`.
- Imports from core use the exports map, e.g. `@metro-labs/mcp/log`, `/train-error`, `/secure-fs`, `/events`, `/lines`, `/endpoints`, `/trains/protocol`, `/stations/types`, `/stations/station-runtime`, `/stations/account-store`, `/stations/attachments`, `/stations/messaging-normalize`. Station packages: `.` → `src/station.ts` (station def), `./train` → `src/index.ts` (train entry).

## Architecture notes

- In-process bus (`src/daemon/events.ts`): inbound flows station → bus → MCP event in one process. It is a bus, not a journal — there is no persistence, replay, backfill, or on-disk history.
- Static seam: stations are wired through the registry in `src/stations/`; core dispatches generically over station defs (verbs/attachment modes), no per-network branching in core.
- Tolerated package cycle: there is a known dependency cycle between core and station packages. It is intentional and tolerated — do NOT "fix" it; madge is configured around it.
- Four out-of-process trains (XMTP, Telegram, Telegram-user, Discord) + webhook handled in-core (no subprocess; `hasAccounts: false`). The telegram-user train only spawns when its session is configured.
- Permission replies (human-in-the-loop): a pending MCP `permission_request` is relayed to chat as `yes <request_id>` / `no <request_id>`; `inbound.ts` matches the chat reply with `PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`. The 5-char-code format is a contract with the relayed prompt — never change one side only.
- REMOVED / don't resurrect: `history.jsonl`, on-disk journal/outbox, the Codex integration (dropped in #16). Don't reintroduce these. The old read-only HTTP "Monitor dashboard" (ring-buffer/backlog replay, `/api/state`, claims/owner-mode filtering) was removed in #40 — do NOT bring those parts back. A deliberately-scoped **lightweight Monitor transport** was reintroduced (`daemon/monitor-api.ts`): live-only `GET /api/tail` SSE (no replay), `POST /api/call/:train/:action`, `GET /api/health`, gated by `METRO_MONITOR_TOKEN` + `METRO_MONITOR_HOSTS`, mounted before the MCP auth gate. Keep it minimal — no history/ring buffer/claims.

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
- MCP reconnect reality: keepalive ping every `KEEPALIVE_INTERVAL_MS = 25_000`. When a client reconnects there is NO backfill/replay — the bus is live-only, so events emitted while disconnected are lost. Don't assume missed events are recoverable.

## Working discipline

- Verify, then act: confirm claims against the code (rg/Read) before changing or asserting. Most "obvious" facts here have load-bearing exceptions.
- Don't flag code as dead/unused without an `rg` search proving zero references across the workspace (including the exports map and station registry).
- Gate-green: full turbo gate must pass before you propose a PR.
- PR/merge: branch off `main`, open a PR, land via PR. Merging to `main` auto-deploys. For stacked PRs, beware `--delete-branch` on merge deleting the base of a dependent PR.
