# Metro Cloud MCP Refactor — Design Proposal

Status: DRAFT for review (Less). Author: background worker (Opus). Date: 2026-06-19.

Goal (from Less): refactor Metro into a **cloud MCP server** and **remove the CLI**. Everything configurable: multiple Discord bots, multiple Telegram bots, webhooks, multiple XMTP accounts, and a single mnemonic from which XMTP accounts are HD-derived. Discord/Telegram tokens registerable as comma-separated env vars (`DISCORD_BOT_TOKENS=tok1,tok2`, `TELEGRAM_BOT_TOKENS=tok1,tok2`).

## 1. Current architecture (as-is)

Two packages in the repo:

- `packages/metro` (`@metro-labs/metro`) — the **daemon + CLI** (bin `metro`).
- `packages/mcp` (`@metro-labs/metro-channel`) — the **MCP server** (stdio) that AI sessions use.

### Daemon
- Bare `metro` command boots the **dispatcher** (`src/dispatcher.ts`): a `TrainSupervisor` that spawns one **train** subprocess per file in `~/.metro/trains/*.ts` (live: `xmtp.ts`, `discord.ts`, `telegram.ts` are **symlinks** into `~/work/metro-protocol/packages/metro/src/stations/*/index.ts`).
- A **train** = long-lived `bun run` subprocess implementing a **station** via `defineTrain({ accounts, onInbound, actions })`. It boots N platform accounts (`Map<id, AccountHandle>`), reads `op:call` JSON on stdin, emits inbound/outbound events on stdout. Supervisor multiplexes the event stream and routes calls.
- **IPC**: CLI ↔ daemon over a Unix socket (`~/.cache/metro/metro.sock`), newline-delimited JSON (`op:forward-call` etc.). The daemon journals mutating calls in a durable **outbox** (idempotency keys) before hitting the train.
- **HTTP+SSE API already exists** (`src/cli/monitor-api.ts`, served on `127.0.0.1:8420` by `startWebhookServer`):
  - `POST /api/call/<train>/<action>` (JSON `{args}`) → `ipcCall({op:'forward-call'})` → train. Bearer-authed via `METRO_MONITOR_TOKEN`.
  - `GET /api/tail` (SSE) → live event stream, modes strict/unclaimed/all, `as=`, `since=` byte offset.
  - `GET /api/state` → recent history + claims + bot ids + version.
  - `POST /wh/<endpointId>` → inbound webhooks (GitHub parsed to one-liners; others generic).

### MCP server (today)
- **stdio** transport, `@modelcontextprotocol/sdk` 1.12.0. Launched via `bun ./metro-channel.ts`.
- **Already talks to the daemon over HTTP**, not the CLI: `metroCall(train, action, args)` = `fetch(${BASE}/api/call/${train}/${action}, Bearer ${TOKEN})`. Inbound via SSE `GET /api/tail`.
- Tools: `send`, `reply`, `react`, `unreact`, `edit`, `delete`, `read`, `create_channel` (xmtp `newGroup` + `setLabels`), `set_channel_metadata` (`setLabels`/`setGithub`/`setPreview`/`updateChannelMeta`). Permission verdicts relayed via chat (`yes <id>`/`no <id>`). **Does NOT yet expose `ask`/poll.**

### Multi-account (already implemented)
`makeAccountStore` (`src/stations/account-store.ts`) gives every station: read accounts JSON → validate → allowlist (`*_ONLY_ACCOUNTS`/`*_ACCOUNTS`) → else single-account env fallback.
- **Discord**: `~/.metro/discord-accounts.json` `[{id, token, owner?}]`; fallback `DISCORD_BOT_TOKEN`. **Already multi-bot.**
- **Telegram**: `~/.metro/telegram-accounts.json` `[{id, token, owner?}]`; fallback `TELEGRAM_BOT_TOKEN`. **Already multi-bot.**
- **XMTP**: `~/.metro/xmtp-accounts.json` `[{id, privateKey|derive, env?, owner?, dbPath?}]`; fallback `XMTP_PRIVATE_KEY`. **`derive` = HD index into `~/.metro/xmtp-mnemonic` (or `XMTP_MNEMONIC`), path `m/44'/60'/0'/0/<index>` via viem `mnemonicToAccount`. Mnemonic-derived multi-account already works.**
- **Webhook/GitHub**: no accounts file; synthetic `github` account; endpoints in `~/.cache/metro/webhooks.json`.

### What is genuinely MISSING vs the goal
1. **Comma-separated token env** (`DISCORD_BOT_TOKENS`, `TELEGRAM_BOT_TOKENS`) — today the env fallback is single-token only; multi requires the JSON file. (Mnemonic + derive-count env for XMTP similarly.)
2. **Cloud/remote MCP transport + hosting** — MCP is stdio-only; the daemon HTTP API binds `127.0.0.1` only; no Dockerfile/deploy config.
3. **CLI removal** — the `metro` bin is still the daemon entrypoint AND the legacy `metro call xmtp ...` path the old orchestrator used.
4. **`ask`/poll not exposed via MCP.**

## 2. Target architecture (cloud MCP)

Keep the **daemon = supervisor + trains + outbox + HTTP/SSE API** as the durable core. The "cloud MCP server" is a thin layer over the existing HTTP API.

```
AI clients ──MCP──► metro-channel (MCP server) ──HTTP/SSE──► Metro daemon ──stdin/stdout──► trains ──► XMTP/Discord/Telegram/Webhook
                    (remote HTTP or stdio)        (/api/call, /api/tail, Bearer)   (supervisor/outbox)
```

- **Transport**: promote the MCP server to **Streamable HTTP** (MCP 2025-03-26) so it is hostable and multi-client, while keeping a stdio mode for local dev. The MCP↔daemon bridge is unchanged (already HTTP). **DECISION needed** (poll Q1).
- **Daemon HTTP API hardening for cloud**: optionally bind `0.0.0.0` behind TLS/proxy; keep `METRO_MONITOR_TOKEN` Bearer auth (consider per-client tokens / scopes later). The webhook receiver and `/api/call`/`/api/tail` already share this server.
- **Hosting**: container (Dockerfile) running the daemon + co-located MCP server; secrets via env; XMTP MLS dbs + outbox on a persistent volume. **DECISION needed** (poll Q2).

### CLI removal → replaced by MCP tools / daemon
Every load-bearing CLI capability already has, or gets, a non-CLI equivalent:

| CLI today | Replacement |
|---|---|
| `metro` (bare) starts daemon | `metro-daemon` entrypoint (rename of the dispatcher boot; no command parsing) |
| `metro call <train> <action>` | `POST /api/call/<train>/<action>` (MCP tools already use this) |
| `metro send/reply/react/read/...` | MCP tools (exist) |
| `metro channel set-github / group new / dm` | MCP `set_channel_metadata` / `create_channel`; add `dm` + `ask` MCP tools |
| `metro tail` | `GET /api/tail` SSE (MCP already consumes) |
| `metro whoami / account list / outbox / doctor / trains` | small **admin MCP tools** or `/api/*` endpoints (e.g. `GET /api/state`, add `/api/outbox`, `/api/trains`) |
| `metro webhook add / tunnel setup` | `/api/webhooks` admin endpoints + config; cloud uses ingress instead of cloudflared |

**RISK (must flag):** the live orchestrator currently speaks via `metro call xmtp ...`. Removing the CLI in one shot would break it AND remove the `metro` daemon entrypoint. Mitigation below (phased, messaging never breaks).

## 3. Config / env schema (target)

Comma-separated multi-bot registration as additive env (file-based JSON still wins / coexists):

- `DISCORD_BOT_TOKENS=tok1,tok2,...` → accounts `[{id:'d0',token:tok1},{id:'d1',token:tok2}]` (ids configurable via `DISCORD_BOT_IDS=alpha,beta`; default `d0..dN`). `DISCORD_BOT_TOKEN` (singular) stays as legacy alias = first token, id `default`.
- `TELEGRAM_BOT_TOKENS=tok1,tok2,...` → same model; `TELEGRAM_BOT_TOKEN` legacy alias.
- `XMTP_MNEMONIC` (+ `XMTP_MNEMONIC_FILE`) + `XMTP_DERIVE_COUNT=N` → derive accounts `x0..x(N-1)` at indices `0..N-1` (path `m/44'/60'/0'/0/<i>`). Optional `XMTP_DERIVE_INDICES=0,3,7` for explicit indices; `XMTP_ENV` for network. `XMTP_PRIVATE_KEY` legacy single-account alias.
- Webhooks: keep `~/.cache/metro/webhooks.json`; add env-seedable `WEBHOOK_ENDPOINTS` (label[:secret] comma list) and `METRO_WEBHOOK_PORT`/bind host for cloud.
- Precedence (per station): accounts JSON file (if present) > comma-separated env > singular legacy env. Allowlist envs (`*_ONLY_ACCOUNTS`) still filter.

This slots directly into `makeAccountStore.fallback`, which is the only function that changes per station (parse the comma list instead of one token).

## 4. Phased migration plan (several PRs — NOT one)

**Messaging (XMTP) must keep working in every PR.** The CLI stays until the orchestrator is fully off it.

- **Phase 1 (additive, safe — candidate for first PR):** comma-separated multi-bot env in the station `fallback`s (`DISCORD_BOT_TOKENS`/`TELEGRAM_BOT_TOKENS`) + `XMTP_DERIVE_COUNT`/`XMTP_DERIVE_INDICES` env-driven mnemonic derivation. No CLI changes, no transport changes. Pure superset of today's config. Tests + docs.
- **Phase 2:** expose missing MCP tools (`ask`/poll, `dm`, admin/read endpoints) so the MCP surface is a strict superset of the load-bearing CLI verbs. Still no removal.
- **Phase 3:** add **Streamable-HTTP** transport to the MCP server (keep stdio); bind/auth options on the daemon HTTP API; Dockerfile + deploy config. Cloud-runnable, CLI still present.
- **Phase 4:** split the daemon entrypoint from the CLI (`metro-daemon` boot with no arg parsing). Move the orchestrator fully onto MCP/HTTP. Verify no caller uses `metro call`.
- **Phase 5:** delete the CLI surface (`src/cli/*` command verbs), keeping only the HTTP API + daemon boot. `metro call` gone; messaging path (trains/outbox/HTTP) untouched.

## 5. Key risks
1. **Breaking the live XMTP messaging path** — the daemon, trains, outbox, and `/api/call` are all in `packages/metro`; gutting `src/cli` must not touch `src/dispatcher`, `src/stations`, `src/outbox*`, `src/trains`, `monitor-api`. CLI removal is last (Phase 5) and only deletes command-verb files.
2. **Daemon entrypoint is the CLI bin** — must extract `metro-daemon` before removing the CLI (Phase 4) or the daemon can't start.
3. **Remote HTTP exposure** — `/api/call` is unauthenticated beyond a single static Bearer token and currently `127.0.0.1`-only. Cloud exposure needs TLS + stronger auth/scoping before binding publicly.
4. **XMTP MLS db / installation identity** — derived inboxes each need a stable db path + installation; the mnemonic is the root secret. Persistent volume + 0600 perms in cloud; never log it.
5. **Webhook ingress** — cloudflared is local-dev; cloud uses platform ingress to the webhook port.
