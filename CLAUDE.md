# CLAUDE.md

## What Metro is

A relay bridging chat networks (XMTP, Telegram, Discord, WhatsApp, inbound webhooks) to an MCP server. One always-on Fly process serves MCP over HTTP and supervises one subprocess ("train") per station with a train. Inbound network message → station → in-process bus → MCP event. Outbound: agent tool call → station verb → network.

## Monorepo layout

Bun workspaces (`bun@1.3.9`): `apps/*`, `packages/*`.

- `apps/mcp` — the core, `@metro-labs/mcp`.
  - `src/mcp/` — MCP server, sessions, tool dispatch, `str()`. No per-channel transport logic.
  - `src/channels/` — `InboundRelay` (`inbound.ts`) turning bus events into `notifications/claude/channel`. Depends on `mcp/`, not vice-versa.
  - `src/monitor/` — the lightweight Monitor transport (`api.ts`).
  - `src/daemon/` — boot, HTTP, supervisor, logging, secure-fs, protocol, event bus. **Never imports `mcp/`** — deps are injected from `boot.ts`, or madge breaks.
  - `src/stations/` — registry, types, account-store, attachments, lines, attach.
  - `src/db/` — drizzle schema, materialize, agent/key/allowlist maps, scope predicate.
- `apps/ui` — the control panel (Vite + react-native-web + `@stage-labs/kit`).
- `packages/*` — six stations: `xmtp`, `telegram`, `telegram-user`, `discord`, `whatsapp`, `webhook`.

## Commands / the gate

- `bun install`. CI and Docker use `--frozen-lockfile`; always commit `bun.lock` or CI/deploy breaks.
- Local run: `bun apps/mcp/src/server.ts`. Prod runs TS from source — `dist/` is built by the gate only, never used at runtime.
- **The gate, all of it, before any PR:** `bun run build && bun run typecheck && bun run lint && bun run knip && bun run madge && bun run test`. Must be green.
- Tests set `DYLD_FALLBACK_LIBRARY_PATH=/usr/lib` (prebuilt `@xmtp/node-bindings` links a nix libiconv; without it the gate is red on darwin only) and `METRO_STATE_DIR="$(mktemp -d …)"`. Run the whole suite; don't assert an exact test count.
- turbo's `test` `dependsOn ["^build"]`, so a core edit invalidates the station packages' cached results.

## Conventions (strict `@stage-labs/config` — HARD constraints)

- **No comments in source. None.**
- No escape hatches: no `eslint-disable`, `@ts-ignore`/`@ts-expect-error`, or `any` casts to dodge types.
- **`no-floating-promises` with `ignoreVoid: false`** (tightened in `stage.config.js`). `void p` is a lint error — it was the sanctioned suppression that let the v157 crash pass lint. Every promise is `await`ed or ends in a `.catch()` that LOGS.
- `max-lines` per file and function-length caps. Split files instead of suppressing.
- Strict tsconfig, ESM. Import specifiers carry explicit `.js` extensions.
- Throw real errors; surface via `errMsg` and `TrainError`. Don't swallow.
- Log via the shared `log`, not `console`.
- Core imports go through the exports map (`@metro-labs/mcp/log`, `/events`, `/lines`, `/stations/types`, …). Station packages: `.` → `src/station.ts`, `./train` → `src/index.ts`.

## Architecture

### Bus and stations

- **In-process bus** (`daemon/events.ts`): a bus, not a journal. Bounded in-memory ring (`BUS_BUFFER_MAX = 500`) keyed by monotonic `busSeq`; `channels/relay.ts` tracks the highest contiguously-delivered seq and replays missed events on rebind. **Do NOT add an on-disk journal or history.**
- **Static seam:** stations are wired through `stations/registry.ts`; core dispatches generically over station defs. No per-network branching in core.
- **Tolerated package cycle** between core and station packages. Intentional — do NOT "fix" it; madge is configured around it.
- **`Station` carries TWO independent booleans: `hasAccounts` and `hasTrain`.** They were once conflated (`hasAccounts: false` meant "no subprocess"); webhook is the one station where they differ (`true`/`false`). `hasTrain` decides the subprocess:
  - `materialize.ts`'s `STATION_TARGETS.webhook.trainImport` is `null`, so `writeStations` writes the account file but no stub, and `pruneStations` blanks the file without `rmSync`ing a stub that never existed.
  - `boot.ts`'s `syncStations` returns before touching the supervisor.
  - `mcp/accounts.ts` reads webhook's accounts in-core (`inCoreAccounts`) instead of calling an absent train — which is also why webhook can never appear in `unavailable`.
  - The Monitor's `/api/call/:train/:action` is a flat 400 for it; `list_members` refuses on `!hasAccounts || !hasTrain`.
- telegram-user and whatsapp trains spawn only when an account of that station exists.
- **The LINE station was removed.** No `line` package, no `line` in `STATIONS` — a leftover `line` row in `accounts` crashes `materialize.ts` at boot. Drop those rows before deploying.

### Sessions, identity and scope

- **`agents.key` is the ONLY credential.** No env bearer, no unscoped principal anywhere. Since `0009` an agent has at most one key and a key belongs to at most one agent (`agents.key` nullable text UNIQUE), which is what makes a bare `?token=<key>` unambiguous with no agent selector.
- `db/key-map.ts` keeps ONE index: SHA-256(key) → agent id, no plaintext. `authenticate()` order: key map → session JWT. Neither is a 401 — **a daemon with nothing configured is CLOSED, not open.**
- `allowedAgents()` is the single place turning an identity into a `Set<number>`; it never returns `undefined`. Use it, don't re-derive.
- **Scoping is by `agents.id`, never by name.** `agents.name` has no uniqueness since `0007`, so a name comparison in an auth path is a cross-owner leak and will NOT be a type error. Do not reintroduce a name-keyed grant.
- **Key reset** (`POST /api/agents/<id>/key` → `resetAgentKeyForEmail`) is a hard cutover with no overlap window: `UPDATE … WHERE id = … AND owner_id = …` (0 rows → 404, retried on `23505`), then `rotateAgentKey` = unregister + register in ONE synchronous call, so the map never holds two live keys or none. Order is load-bearing: row commits → map swaps → new key goes out. `registerKey` alone is NOT a rotation — it adds a hash without evicting the old one, which `test/key-map.test.ts` pins. Registration is skipped on a `METRO_AGENT`-pinned daemon that doesn't serve the agent; **eviction is unconditional.** `boot.ts` composes the reset with `closeAgentSession(id)`, since an attached SSE stream never re-authenticates.
- **Per-identity MCP sessions** (`mcp/session.ts`). `McpSession` owns everything that was once a module-level singleton: its own `mcp.Server`, transport, `_GET_stream` sink, `ChannelOwner`, `BoundedEventStore`, `InboundRelay`, `ChannelRelay` and bus subscription.
  - `mcp/session-registry.ts` holds two indexes filled together (session id → session, scope key → session) so a lookup by either cannot drift.
  - The scope key (`sessionScopeKey`) is the SORTED agent id set, not the identity: an `agents.key` and a Google session over the same agent are the SAME session.
  - At most one live session per scope key. A second `initialize` from the same identity supersedes; a second identity does not touch it.
  - `rebindDecision` is GONE. `routeSession` returns `use` for an id the caller owns, a flat 404 for one somebody else owns, `create` with `adoptId` only for an id nobody owns. `initialize` never adopts.
  - Lifetime: idle streamless sessions reaped after `SESSION_IDLE_MS` (10min) by a 60s unref'd sweeper; `MAX_SESSIONS` 64, evicting the LRU **streamless** session and refusing with 503 rather than dropping a live one.
  - `ReplayLedger`s live in a registry LRU keyed by scope key, so a message that arrived while an agent was disconnected survives reconnect AND full re-initialize.
  - `InboundRelay` state (`knownLine`, `allowedLines`, `seenEvents`, `pendingPermissions`) is per session, so one agent's chat reply cannot answer another's approval prompt. The dedupe key still strips the account segment (that is what collapses one agent's two accounts in one conversation) but is prefixed by the owning agent id.
  - Do NOT re-collapse any of this into a singleton. `test/session-concurrency.test.ts` drives two agents over real HTTP and fails first if you do.
- **Adoption is silent, so an adopted session must be told the tool schema may have moved.** Armed by a schema SIGNATURE, not the adoption flag: `toolSchemaSignature()` is a memoized hash of `toolList()`, `issuedSchema` is the signature the session was issued (`undefined` when adopted), and `schemaNoticeDue` is `issuedSchema !== toolSchemaSignature()`.
  - **Arming is not delivering.** The notice rides whichever egress the client is actually reading: `announceToolSchema` on a GET bind (guarded by `streamAttached`), or `extra.sendNotification` from inside the `tools/call` handler, which the SDK routes onto that request's own response stream. `tools/list` settles it silently (`markCurrent`) — notifying there is a refetch loop. `issuedSchema` updates only once the send RESOLVES; an `announcing` latch stops two concurrent calls both sending. Pinned in `test/schema-notice-without-stream.test.ts` and `test/mcp-session-restart.test.ts`.
  - **The ceiling: the daemon cannot reach a client that is neither streaming nor calling.** The SDK client opens its GET stream once, retrying twice at 1s and 1.5s; any deploy outage exceeds that and the stream is gone for the life of that client process. Such a client keeps making tool calls and receives no inbound chat at all. Only a `/mcp` reconnect or client restart fixes it. **Tell the user to reconnect after every deploy.**

### One scope predicate, every egress (`db/agent-scope.ts`)

- `lineTargetDenied` resolves `args.line` → agent id and denies anything outside the scope set, including an `args.account` override that would re-route to another agent's account (stations resolve `account ?? line`, which is the hole a line-only check leaves). `mcp/index.ts`'s `scopeDenied` and the Monitor's call gate are that one function.
- `stationFullyScoped` covers a call naming no line (`accounts`): allowed only when every account of that station is in scope.
- **`eventInScope` is the delivery filter for EVERY inbound egress and FAILS CLOSED.** An account-station line (the `STATIONS` list in `db/schema.ts`) whose account maps to no agent goes NOWHERE. An unparsable line reaches nobody.
  - The remaining carve-out is by STATION, not by lookup failure: a line on a station with no accounts at all (local `metro://claude/…`) still reaches every authenticated tail. **Do NOT remove it wholesale** — `metro://claude/…` depends on it.
  - `webhook` is IN `STATIONS`, so an endpoint reaches its owning agent and nobody else.
- **Four egresses, one case table** (`test/egress-scope-matrix.test.ts`): channel live, channel bus replay, SSE resumption, monitor tail. **Add a new egress to that table or it will leak.**
- **SSE resumption is a separate egress.** `serveStandaloneGet` replays `BoundedEventStore` before the sink is bound and without consulting `ChannelRelay`, so gating the relay alone left a real leak with no log line at all. `storeEvent` records the frame's `meta.line` and the `ChannelOwner` scope in force; `replayEventsAfter` takes the reconnecting scope as a REQUIRED option and re-checks every frame through `mcp/frame-scope.ts` → the same `eventInScope`. `scope: undefined` replays NOTHING. Withholding does not consume the frame — the store is a buffer, not a queue. Both gates are kept and are redundant by construction; **do not remove either** on the grounds that isolation makes it unreachable.
- The Channel applies scope through `ChannelOwner` (`mcp/channel-owner.ts`), which records the identity that authenticated the currently-attached GET stream — that stream is the wire, so it decides scope. An out-of-scope event is WITHHELD, not dropped, so the ring buffer replays it to its real owner. With no stream attached nothing is deliverable, which keeps events alive rather than writing them into a transport with no reader.
- `streamBelongsTo` is the last-line guard on a stream takeover (409); unreachable while routing is correct, which is why it stays.
- `permission-relay.ts` re-checks `owner.inScope(relay.knownLine)` before pushing an approval prompt, because a prompt is Claude's tool name and input preview.

### Never fatal

- **Nothing in the relay path may kill the daemon** (the v157 outage: one unwritable `mcp.notification()` took every station down). A notification failing because a client vanished is normal.
- Pinned by `test/never-fatal-notify.test.ts` (against a real closed SDK `Server`) and `test/crash-guard.test.ts` (through real subprocesses, the only honest way). Three layers, all kept: the `flushPendingFallback` timer `.catch()`es and logs; `ChannelRelay.enqueue` terminates its chain with a `.catch()` so one failure cannot poison the chain; `daemon/crash-guard.ts` installs `unhandledRejection` + `uncaughtException` as the FIRST statement in `boot.ts`.
- The guard is asymmetric on one flag: before `markDaemonReady()` a crash exits 1 (a daemon with no HTTP server should crash-loop visibly); after ready it logs at `error` with a per-kind counter and keeps relaying. `/health` is the independent backstop for a genuinely wedged process.
- The fatal path does NOT go through pino — `logFatalSync()` writes one pino-shaped line with `writeSync(2, …)`, because `pino.destination(2)` is async and `process.exit` truncates it (`flushSync()` does not fix it).
- Keepalive `res.write`s in `raw-get-stream.ts` and `monitor/api.ts` are the same class in sync form: guarded, and they close the stream.

### Attachments

- **Inbound:** a station emits `attachmentSaved` when bytes land and `attachmentFailed` (same correlation fields plus `reason`) when they cannot. Both go through ONE correlator (`InboundRelay.mediaCtxFor`), so a failure consumes the pending slot exactly like a success and clears the 15s fallback timer. That timer is right for a download that never returned and wrong for one refused outright. Failure notes advertise no `url` and no `local_path` — there is no file. Only whatsapp emits `attachmentFailed` today; the rest still fall through to the timeout.
- `saveStreamToCache` streams to a `.part` with a running `assertAttachmentSize` counter and `rename`s on completion, so RSS stays flat and a refused save leaves neither a half file nor an orphan.
- **Serving** (`daemon/attach-serve.ts` + `attach-owner.ts` + `attach-grant.ts`) is scoped by the OWNING agent, not a shared secret. Minting a url writes two 0600 sidecars beside the cached file: `.owner` (agent id) and `.grant` (`{token, agentId, mintedAt}`, `at_<43 base64url>`, 32 CSPRNG bytes). The `?token=` is that per-attachment token, never the agent's key. Minting is idempotent for the same owner, so re-emitting an event does not break a delivered link.
  - `/attach` takes two paths, both re-checking `.owner` first: the presented token matches that attachment's own grant (`timingSafeEqual`, and the grant's `agentId` must equal the recorded owner), OR the caller authenticates as an identity whose scope contains the owner. Everything else is a flat 401.
  - The ONE 404 is a name that is not cache-shaped (`CACHE_NAME_RE`), decided before `authorized()` — it depends only on the request string. A cache-shaped name stays 401 whether or not it exists: cache names derive from public ids (a discord snowflake), so a distinguishable "gone" would be an existence oracle. **Do not "improve" that 401 into a 404.**
  - Fails closed: no `.grant` means no token can match. Sidecars are unservable by construction (`CACHE_NAME_RE` cannot match two dots).
- **Outbound sources** (`stations/attach-resolve.ts`, `attach-inline.ts`): exactly ONE of `upload`, `data`, `url`, `path`. Two is an error and so is none — the old filter that swallowed a source-less entry is gone, because dropping it and answering `sent: text` is the #134 dishonesty.
  - `path` resolves on the DAEMON host; `url` must be publicly reachable; `data` transits the model's output. `upload` is the only one fit for a real file.
  - **`data` is for TINY files.** `MAX_INLINE_BYTES` is 8 MiB decoded, per attachment and per send — derived so the limit-naming error fires before `MCP_BODY_MAX` (32 MiB) answers a bare 413. Don't raise one without the other. But the binding limit is the model, not the daemon: the practical ceiling is roughly **10 KB**, three orders of magnitude below the cap.
  - base64 is validated strictly (alphabet, whole quanta, decoded-length equality) because `Buffer.from(x, 'base64')` silently drops junk. `splitInlineData` strips a `data:<mime>;base64,` prefix and adopts that mime when `mime` is omitted; a `data:` url without `;base64` is refused.
  - Inline bytes land in a per-attachment `mkdtemp` (0700) under `os.tmpdir()`, **never `attachDir()`** — that cache is durable and is the only thing `/attach` serves. `cleanupAttachments` runs in a `finally` on success, station error and under-report alike. Stations only ever see a local file, so no base64 crosses the train stdin pipe — `drainLines` would drop a call line over `STDOUT_LINE_MAX` (4 MiB) in silence.
- **The upload endpoint** (`daemon/upload-store.ts` + `upload-api.ts` + `mcp/upload-tool.ts`). Bytes go over HTTP from the caller's disk to the daemon, never through an MCP message. **One step needs a SHELL and there is no way around it** — an MCP tool call is model output by construction. `create_upload` mints the slot and returns a ready-to-run command; pushing bytes is `curl`. An orchestrator-only main loop should delegate the one command and keep the `upload_id`; the slot belongs to the metro AGENT, not whoever ran it.
  - Two ways in: `POST /api/uploads?name=&mime=` with the raw body, authenticated by the agent's key (owner is the single agent in scope, or `?agent=<id>`); or `create_upload` → `PUT /api/uploads/<id>?token=<ut_…>`, where the ticket is the only credential on the wire. `DELETE` drops a confidential file early.
  - Ownership reuses #130's primitives, not a copy. Same two paths as `/attach`, failing closed the same way, but everything else is a flat **404** — an upload id is an unguessable capability, so "exists but not yours" would be an oracle. At `send` time `fromUpload` re-checks the owner against `allowed`, passed IN as a parameter (`stations/` must not import `mcp/`); `allowed === undefined` resolves NOTHING.
  - **Transient by construction:** `uploadDir()` (0700), never `attachDir()`. `UPLOAD_TTL_MS` 30 min, expiry read from `.meta` on EVERY lookup, `startUploadReaper()` sweeping every 60s with one sweep at start. `UPLOAD_ID_RE` (`up_` + 22 base64url) is the traversal guard and makes sidecars unaddressable. A send does NOT consume the upload — a timed-out `send` has usually succeeded, so a retry must work.
  - **64 MiB per file, 512 MiB daemon-wide live budget.** Under `MAX_ATTACHMENT_BYTES` (100 MiB) so the naming error fires first, and above the largest station ceiling (Telegram's 50 MB) so metro never refuses a file a station would carry. Over-size is refused from `content-length` before a byte is written; a chunked body is caught by the running counter, which **DRAINS rather than throws** — throwing there destroys the socket in Bun's `node:http` and the client hangs forever. Drain capped at `DRAIN_MAX` = 2x. Do not "simplify" it back into a throw.
  - `streamToSlot` owns removing the `.part` on failure, not its callers: the `wx` open makes an orphan permanent, wedging that slot at 409 for the full TTL.
- **Outbound reporting is derived, never asserted** (#134). `handleSend` compares what came back against `atts.length` through ONE predicate, `assertDelivered`, applied to both the forwarded and native paths. **Fewer labels than attachments is an error, never a success.** Each station's label list must be built INSIDE the loop that pushes, appended only after the push resolves, and derived from the branch that chose the verb — never `map`ped over the input array, which is what let telegram-user report full success for a partial send. `test/send-attachment-honesty.test.ts` crosses drop/partial/complete against every station's line; add a station to it and to the package's own send-loop test.

### Human-in-the-loop

A pending MCP `permission_request` is relayed to chat as `yes <request_id>` / `no <request_id>`; `inbound.ts` matches with `PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`. The 5-char format is a contract with the relayed prompt — never change one side only.

### Connectors (`db/connectors.ts`, `daemon/connector-*.ts`)

A connector is a **user-level verified bookmark for a remote MCP server**, plus a paste-ready `mcpServers` block. Metro stores it and proves it answers — it does NOT proxy it, holds no runtime session to it, gives it no MCP tool and puts nothing on the bus.

- **A connector is NOT a station and carries no egress.** Nothing on this path touches `STATIONS`, `stations/registry.ts`, `materialize.ts`, `db/agent-scope.ts` or `eventInScope` — there is no fifth egress to add to the case table. Don't "unify" it with stations.
- **Owned by `users.id`, never `agents.id`.** It belongs to the signed-in person, not to an agent, which is why the sidebar page is user-level and takes no agent. `ownedConnectorOrThrow` re-asserts `user_id` in the WHERE, so not-yours and unknown are the SAME 404.
- **No row exists unless the remote answered a real MCP `initialize`** — the attach rule, applied to a station-less feature. `createConnectorForEmail` verifies BEFORE the insert, so `config.verified` is present on every stored row by construction.
- **`parseConnectorUrl` is a security boundary, not validation polish.** https only; no IPv4/IPv6 literal, no `localhost`, `*.local`, `*.internal`, `*.flycast` or bare single-label host; no userinfo, no `#fragment`; every frame is `redirect: 'manual'` and a 3xx is refused rather than followed. The fetch is made by the Fly machine that holds `DATABASE_URL`, the pg pool and `/data` with the MLS db3s, at a url named by ANY signed-in Google account — sign-up is open by design. DNS rebinding is accepted for v1, and the channel stays blind: never echo a remote body or header back to the caller.
- Raw `fetch`, never the SDK `Client` — its `requestInit.signal` is overwritten by the transport, its default timeout is 60s, and after `initialize` it starts an unawaited background GET SSE with reconnect backoff. Streamable HTTP only: `transport` is always `'http'` on a written row, and the column exists so `sse` needs no migration. **No stdio, ever** — the only way to "verify" it is to execute a user-supplied command line on the Fly box.
- **A remote 401 is metro's 400, never metro's 401** (`ConnectorVerifyError` is always 400, like every `stations/attach.ts` provider refusal). 401 is reserved absolutely for a missing or invalid metro session: `apps/ui/src/api/client.ts` throws `AuthError` on ANY 401 and `App.failed` answers with `clearSession()`, so proxying a remote refusal would log the user out mid-form. On re-verify it is not even an error — `verifyConnectorForEmail` catches `ConnectorVerifyError` into `200 {ok:false, reason}` and leaves the row alone; anything else rethrows.
- `unique(user_id, name)` is structural, not cosmetic: the name is the `mcpServers` object key, so two connectors named `linear` would silently overwrite each other in the copied JSON. Duplicate → 409 via `isUniqueViolation`.
- **`GET` re-serves the auth header value to its owner — the SECOND deliberate relaxation of "no API returns a stored credential"** (the webhook url is the first). The whole feature is *copy the JSON*, so a write-only store is useless; metro is the holder, not the issuer — the user already has this credential; and it is gated by the same session JWT that re-serves `agents.key` in plaintext next door. The mitigations are not optional: the field is named `secret` so no row renders it as a clickable link, the UI masks it behind Reveal/Copy, and **neither the url nor the value ever reaches `log`** — `{id, name, host}` only.
- **The route MUST stay in `handlePreMcpRoutes` before `handleMonitorRequest`**, which claims all of `/api/*` and never falls through. `connectorApi` is the optional 5th positional parameter of `startWebhookServer`/`handleRequest`/`handlePreMcpRoutes`; do NOT fold it into `AgentApiDeps`.
- Migration `0010` adds the table, and **migrations are manual**: no `migrate()` at boot, no CI step, no `release_command` in `fly.toml`, and `drizzle-kit` is a devDependency absent from the production image. `bun --filter @metro-labs/mcp db:migrate` must be run against prod BEFORE the PR merges, because merging to `main` auto-deploys.

## HTTP surface

One port (`internal_port=8420`, `webhookPort()` = `METRO_WEBHOOK_PORT || 8420` — an overridable default, not a constant) serves MCP, the APIs, webhooks and health.

`handlePreMcpRoutes` runs in order, and **the order is load-bearing: the monitor router claims all of `/api/*`**, so anything under `/api/` must be mounted before it.

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /health`, `/healthz` | none | 200 `{status,version,uptime}`. Fly health-check (30s/5s/45s grace). **Breaking or gating this = machine unhealthy = outage.** A test guards it. |
| `/auth/google/*` | — | Sign-in; `withFragment` strips the hash on return. |
| `/api/agents…` | session JWT | Agent + account admin. Anything else under it is a 404 from this handler. |
| `/api/connectors…` | session JWT | User-level remote-MCP bookmarks; **never an agent key**. `GET`/`POST` the collection, `POST /<id>/verify`, `DELETE /<id>`. Anything else under it is a 404 here, a wrong method a 405, both decided before auth. |
| `/api/uploads…` | agent key or ticket | See attachments. |
| `/attach` | grant token or owner scope | See attachments. |
| `/api/webhooks/<webhook_id>/<token>` | the URL itself | Inbound webhook. |
| `/api/tail`, `/api/call/:train/:action`, `/api/health` | same `authenticate()` as `/mcp` | The Monitor transport. |
| `/`, `/mcp` | agent key or session JWT | MCP. |

### Agent API (`daemon/agent-api.ts`)

- `GET`/`POST /api/agents`, `DELETE /api/agents/<id>`, `POST /api/agents/<id>/key`, plus the account sub-resource in `daemon/account-api.ts`.
- Gated by the Google session JWT only — **never an agent key.** An agent key cannot reset itself.
- Shared plumbing in `daemon/api-http.ts`; every status-carrying error extends `ApiError`. `apiFailure` maps exactly `AgentAdminError` and `StationAttachError` to their status and everything else to a logged 500.
- **`GET` returns the agent's key VALUE** (plus `?token=` endpoint and paste-ready command) for agents the session OWNS, and lists nothing else. The exposure is gated TWICE and **both gates must stay**: the list query selects only (`id`,`name`,`owner_id`), `selectKeyRows` re-reads `key` for owned ids ONLY, and `agent-api.ts` re-checks `agent.owned` before serialising. `AgentRow` has no `key` field, so the assembly step cannot serve a key it was not handed.
- `toAgentSummaries` derives `owned` and the key exposure from ONE predicate (`ownerId !== null && r.ownerId === ownerId`) so they cannot drift. **The null guard is load-bearing** — without it a caller with no `users` row would be handed every operator-provisioned row as owned.
- Ownership resolves `owner_id` from the DB per request, not from the JWT, so a new agent appears without re-login.
- DELETE is owner-only by id: not-yours / unknown / `owner_id IS NULL` → 404; still-attached accounts → 409. `ownedAgentOrThrow` is shared by delete, attach and key reset so their predicates cannot drift.
- `gatherAccountsForAgents` stamps each account with its owning `agentId` for the UI. That is display metadata on the `/api/agents` path only — `scopeAccountsByAgent` decides visibility. The MCP `list_accounts` tool still calls plain `gatherAccounts`.

### The paste-ready command (`mcpAddCommand`)

`claude mcp add --transport http metro "<endpoint>?token=<key>"` — mirrors the Browserbase shape byte for byte.

- **No `--scope user`**, so it registers only for the pasting directory. Less's explicit call; do NOT "fix" it. `--transport` stays spelled out for the same reason.
- **The server name is the constant `metro` for every agent** (#124), never the agent name or a slug. Only `?token=` differs. That constant is also what makes the line safe whatever is in `agents.name` — a name with a space used to paste as a broken two-word server. Known consequence: two metro agents in one Claude Code config collide on the second add. Accepted — it is a collision in the pasting person's own config, and nothing on the auth path reads this string.

### Attaching station accounts

- `POST /api/agents/<id>/accounts/start` is the **ONLY** route that writes `accounts`.
- **No `accounts` row exists unless the credential has been demonstrated to work.** Every station is verified against the real provider BEFORE the row is written: discord `GET /users/@me` plus the `/applications/@me` Message Content flags, telegram `getMe`, xmtp opens a real inbox with the key it just generated. Well-formed is not enough — a generated secp256k1 key is well-formed by construction.
- The xmtp check runs OUT OF PROCESS (`Bun.spawn`, key over stdin, never argv/env, 90s cap) because `@xmtp/node-sdk` v6 exposes no `close()`, so an in-daemon client would hold the MLS SQLite handle for the daemon's life and fight the train. It verifies into the SAME db3 the train will use and stores that path in `config.dbPath`, so the train reuses the verified installation instead of burning one of the inbox's ten. On a failed write, `discard()` deletes the db3 and its sidecars. Refusals run through `withoutKey`.
- `account_id` is ALWAYS server-generated (`a<agentId>-<8 hex>`), never from the body — (`station`,`account_id`) is a global PK, so a caller-chosen id would collide across owners and leak which ids exist.
- Duplicate bot tokens are refused 409 (two telegram accounts sharing a token make the whole train refuse to boot).
- **No API returns a stored station credential** — the one-time `secret` in the 201 is the only time a generated XMTP key is shown. The single deliberate exception is the webhook endpoint url (see the webhook station).
- **Interactive attach** (`daemon/attach-session.ts`): telegram-user and whatsapp cannot finish in one request, so `start` answers `status:'pending'` with an `as_<22 base64url>` id, and the client polls, posts `/step`, or `DELETE`s. `ATTACH_ID_RE` is disjoint from every station name, which lets one route table serve both shapes.
  - `AttachSessions` is IN MEMORY ONLY. It holds the live provider client and hands the finished config straight to the write; no credential reaches a view or poll response.
  - `authorize` runs `ownedAgentOrThrow` BEFORE any provider client is created.
  - 5-min pending TTL, 1-min settled, 2 per agent, 40 per daemon, 15s unref'd sweeper; expiry/cancel/`stop()` all call `driver.cancel()`.
  - Login modules live in the STATION packages and are pulled in by DYNAMIC import, so `@mtcute/bun` and Baileys are not loaded at boot.
  - The whatsapp driver closes its pairing socket BEFORE the train boots with the same creds, or the two fight. Baileys' `connection: 'close'` with 515 right after pairing is a REQUIRED restart, not a failure.
- After a write, `reloadAccountsFromDb()` re-reads Postgres and rewrites the account files and maps. `writeStations` rewrites a train stub only when its CONTENT changes (`writeIfChanged`) — the supervisor watches that directory and an unconditional rewrite would restart EVERY station on every attach. Reactivation is `TrainSupervisor.requestReload(name)`, sharing the fs watcher's debounce map so the two collapse into one restart; `stopTrain(name)` is the detach-the-last-account path.

### Monitor transport (`monitor/api.ts`)

Live-only `GET /api/tail` SSE (no replay), `POST /api/call/:train/:action`, `GET /api/health`. Same `authenticate()` and `allowedAgents()` as `/mcp`, so it grants nothing the Channel does not. Enabled iff the daemon holds a credential at all (`hasAnyKey()` or `METRO_SESSION_SECRET`); otherwise the whole `/api/*` surface 404s. `/api/health` stays in front of the auth gate — its body is what `/health` already serves unauthenticated. **Keep it minimal: no history, ring buffer or claims.**

## The UI (`apps/ui`)

- **Not an MCP client** (#113) — `apps/ui/src/mcp/client.ts` was deleted and must not come back. It uses `fetch('/api/agents')`.
- Two panes: the sidebar is the agent list, Settings, and the account footer; everything agent-specific belongs to the selected agent in the main pane.
- Routes are hash-based: `#/`, `#/agent/<id>`, `#/station/<account_id>`, `#/connectors`, `#/settings`, `#/docs/setup`, `#/login`. `routeHash` ends in `return '#/'` and is NOT exhaustive, so a new kind that is only added to `routeSelection` fails silently.
- **`#/connectors` is user-level, not agent-level** — a `standalonePage` beside Settings and Docs. `Connectors` owns its own fetch and state and takes only `token`, because `Dashboard()` is 92 non-blank lines against the 100 cap: keep zero new lines inside it. Consequence, accepted: the NavRow shows no count.
- **A station account has its own page.** The list row carries only identity (icon, station, handle) and is itself the link; every returned field lives on the station page. `stationFields` (`api/accounts.ts`) is the ONE place deciding which fields are identity and which are detail — a field the daemon could not fill comes back `-` and is dropped, since a dash is not a fact.
- Attach/detach controls render only when `agent.owned`; the UI hiding them is convenience, `ownedAgentOrThrow` is the enforcement. Accounts never render globally — the pairing is structural, never inferred. The one exception is a session seeing exactly ONE agent, where every account is by construction that agent's.
- **`apps/ui/public/fonts/Calibre-*.woff2` are the only binary assets and the only files the MIT `LICENSE` does not cover** — a commercial Klim face under Snapshot Labs' licence. Do not copy them elsewhere and do not delete them as "unused": nothing imports them, `index.css` names them by url and Vite copies `public/` verbatim. Each file is its own single-face family at `font-weight: normal`, because the kit hardcodes the family names and never sets a weight. `test/fonts.test.ts` guards the pairing.

## Stations

| Station | Train | Message verbs | Notes |
| --- | --- | --- | --- |
| xmtp | yes | `send`/`reply`/`react`/`unreact`/`read` + push, group ops | Production XMTP/MLS. DB `~/.metro/xmtp-production-<id>.db3`. Single-writer. Use a separate identity for dev. |
| telegram | yes | `send`/`reply`/`react`/`unreact`/`edit`/`delete` (no `read`) + six `send_*` | Bot API. |
| telegram-user | yes | all seven | Telegram **user account** (MTProto via `@mtcute/bun`). Config `{session, apiId, apiHash}`. ToS/ban risk; the session is a full-account secret; single-writer. Dormant until an account exists. |
| discord | yes | all seven + thread/pin/typing/presence/voice | Voice via `@discordjs/voice`. |
| whatsapp | yes | `send`/`reply`/`react`/`unreact`/`edit`/`delete` (no `read`) | Real user account via Baileys. See below. |
| webhook | **no** | none (inbound-only) | See below. |

Allowlists resolve via account-store `allowlistEnv`: `<STATION>_ONLY_ACCOUNTS` restricts, `<STATION>_ACCOUNTS` configures (`XMTP_`, `TELEGRAM_`, `TELEGRAM_USER_`, `DISCORD_`, `WHATSAPP_`).

Every station's `accounts` action reports `handle` + `url` for the UI. All of them swallow a failed identity lookup into `null`, so a blank handle means the provider call failed (e.g. a revoked telegram token) — the daemon knows the reason and currently shows none. Worth fixing.

### whatsapp

Package `baileys` (`@whiskeysockets/baileys` is the OLD name; both publish `7.0.0-rc*`). Config `{phone}`; the Baileys auth blob lives in the SAME `accounts.config` jsonb under `config.credentials`, spread into the account file by `materialize.ts` — **the train opens no pg connection.** `useAccountAuthState` holds creds + Signal keys in memory and never writes creds back (`saveCreds` is a no-op; Signal sessions re-establish on demand). Pairing survives deploys and volume loss. Fails loud if the blob is missing. Two writers of the creds: `scripts/login.ts` and a web-UI attach session; the running train writes nothing.

- **Exactly two key types are durable, and the reason is 463.** Baileys 7 attaches a trusted-contact token (`tctoken`) to every 1:1 send, and WhatsApp answers a 1:1 send without one with `ack error 463` — it counts as reaching out to a stranger and time-locks the account. The token is issued to us BY the contact and Baileys' own index-pruning assumes that store is persisted, so an in-memory-only store is the 463 back on every deploy, each refusal deepening the lock. `src/token-store.ts` persists `tctoken` + `lid-mapping` (the PN ↔ LID index the token is filed under) to `~/.metro/whatsapp-tokens-<account>.json`, 0600, debounced 1s, seeded back on boot. Losing the file degrades to the old behaviour, never to a failure. **Do NOT extend this to `session`/`pre-key`/`sender-key`/`identity-key`/`app-state-sync-key`/`device-list`** — `creds` carries the pre-key counters and is still never written back, so persisting half a Signal state is worse than persisting none.
- **A message key is not synthesizable** (`src/keys.ts`). In a GROUP the address is (`remoteJid`, `id`, `fromMe`, **`participant`** = the original author), and a key correct in a 1:1 is wrong in a group in exactly that field: with `participant` missing, Baileys and WhatsApp's own clients fill it from the REACTION's sender, so the reaction resolves to a message that does not exist — accepted, ACKed, rendered nowhere. 1:1 worked by luck. The fix is a per-account bounded LRU (`makeKeyCache`, 4000) filled from EVERY `messages.upsert` (before the `fromMe` filter — our own sends must be in it) and from the key `sendMessage` returns, reused VERBATIM, which also sidesteps lid-vs-phone address spaces. The cache dies with the train, so `react` on a group message this connection never saw FAILS LOUD (`whatsapp_unknown_message`) rather than reporting success for a send that displays nothing. Do NOT "simplify" any of these back to a constructed key.
- **A refused send is an error, and the verdict is read off the raw socket** (`src/ack.ts`). `sendMessage` resolving only means the stanza left the socket; the verdict arrives as `<ack class="message" error="…">`. `send` waits `METRO_WHATSAPP_ACK_WAIT_MS` (5000, `0` disables) and THROWS — `whatsapp_account_restricted` for 463 (naming the timelock, `retryable: false`), `whatsapp_send_refused` otherwise. No ack inside the window is still reported as sent: the absence of a verdict is not a verdict. **The hook must STAY on `sock.ws`** (`CB:ack,class:message`) — Baileys re-emits the same ack through the BUFFERED emitter, and a stuck buffer eats it; `ws` frames bypass the buffer. `messages.update` is kept as the delivery log.
- **Inbound media** covers all five types (plus the `viewOnce`/`ephemeral`/`documentWithCaption` wrappers). `kind` is six-way, not five: WhatsApp ships a voice note and an mp3 both as `audioMessage`, distinguished ONLY by `ptt`, so a kind derived from the mime cannot tell them apart — the station's kind rides on the payload and wins. `mimetype` is stripped of parameters or the cache file gets `.bin`; a node with no `fileName` gets one synthesised from the SAME `extFromMime` the cache name uses. `reuploadMedia` is wired in as Baileys' `reuploadRequest`, which recovers a file WhatsApp already expired from its CDN.
- **The ceiling is `MAX_ATTACHMENT_BYTES` (100 MiB default, `METRO_ATTACH_MAX_BYTES`), metro's, not WhatsApp's** — between 100 MiB and WhatsApp's 2 GB document limit metro is the thing refusing. It refuses honestly and for free: every media node declares `fileLength`, so the size is asserted before a byte is fetched. The download timeout is metro's too (`withIdleTimeout`), because Baileys 7 typechecks a `signal` and then drops it.
- `sock.end()` is `async` in Baileys 7 and must be awaited.
- **A second Baileys client on live credentials is an OUTAGE, not a test** — the sockets share one device identity, the newest wins, and Signal state diverges. Verify inbound media against a local `mmg.whatsapp.net` in a private mount namespace instead. ToS/ban risk: use a dedicated number.

### webhook

`hasAccounts: true, hasTrain: false` — an endpoint is an `accounts` row, so it is OWNED by one agent and scoped like any other station.

- **Attach:** `{"station":"webhook"}`. No provider exists to verify, so `prepareWebhook` mints a `webhookId` and a `secret`, stores `{secret, webhookId, createdAt}` in `config`, and puts the finished `endpoint` straight on the 201's `identity`.
- **The url names the `webhookId`, NEVER the `account_id`.** That is why the second id exists: `account_id` is `a<agentId>-<8 hex>`, so a public url built from it would publish the internal agent id to every provider it is pasted into. `webhookId` is 19 random digits (`newWebhookId`) and carries nothing. The PK, the agent map key and the event line all stay `webhook/<account_id>`; `findEndpointByWebhookId` is the only lookup the route may use.
- **Inbound:** `POST /api/webhooks/<webhook_id>/<token>`. **The whole URL is the credential** — no signature header, deliberately: an HMAC is a real gate but most providers cannot compute one, and the header was what made this unusable. The token is 48 CSPRNG bytes base64url compared with `timingSafeEqual`; everything that is not an exact match is a flat 404, including an `account_id` in the id position and a row missing either field. `GET` is a 200 readiness probe with no event; anything else 405.
- **The route MUST stay in `handlePreMcpRoutes` BEFORE `handleMonitorRequest`** or the monitor router swallows it. `webhook-station.test.ts` boots WITH a `monitorCall` and asserts `/api/tail` still 401s while the hook 200s — the only way that bug is visible.
- The token never reaches a log or the event: `webhookEntry` is handed `hookPath(id)`, not `req.url`.
- **This is the ONE place the no-API-returns-a-station-credential rule is relaxed.** `inCoreAccounts` re-serves the full url to the owning agent on every `GET /api/agents`, because a url you cannot retrieve is useless — you paste it into a provider days later. The blast radius differs in kind: a bot token or XMTP key controls an account on someone else's network, this one only posts events INTO its own agent. Scoped by the same `scopeAccountsByAgent`, surfaced as `endpoint` rather than `url` so the row's external-link button never makes a credential clickable, and masked behind Reveal/Copy in the UI.
- **Delivery needed TWO fixes.** Dropping the `station === 'webhook'` check in `inbound.ts` was necessary but NOT sufficient: `classifyEvent` types an external webhook as `{type:'system'}` and `routable` only routed `msg`/`react`, so an attached endpoint answered 200, emitted, and reached NOBODY. `system` is routed now, safe because that branch is its only producer in the workspace.
- The note (`channels/webhook-note.ts`) carries the pretty-printed body — the summary line alone tells an agent nothing — capped at `MAX_BODY_CHARS` 8 KiB with the dropped count named, plus an ALLOWLIST of headers, never the whole map: a delivery's `authorization`, `cookie` and signature must not land in the agent's context.
- Two consequences of routing a `system` event: `handleEvent` does NOT set `lastLine` for one (that is `knownLine`, where an approval prompt goes, and a webhook line has no `send` verb), and `handlePermissionReply` runs only for `msg`, so a body containing `yes abcde` can never answer a pending request.
- `listEndpoints` reads the materialized `~/.metro/webhook-accounts.json`, not the pre-account `webhooks.json` (warned about once at boot by `warnOnLegacyWebhooks`).

## Database / multi-agent (Postgres + Drizzle)

**The DB is the ONLY runtime account source** — nothing reads station secrets from the environment.

Four tables in `db/schema.ts`. BOTH foreign keys point at `users.id` `ON DELETE RESTRICT` — `agents.owner_id` and `connectors.user_id` (a user who still owns either cannot be deleted); `accounts` references its agent by a plain int with no FK.

- `users` — `id`, `email` UNIQUE and always lowercased through `normalizeEmail`. One row per person, created on first Google sign-in.
- `agents` — `id` (the real identity, the only thing scoping compares); `name`, a display label with NO unique index since `0007`, so it may repeat across and within owners and differ only in case; `owner_id` nullable (NULL = operator-provisioned); `key` nullable text UNIQUE.
- `accounts` — `agent_id`, `station` **plain text, not a pg enum**, so a new station needs no migration (adding `webhook` needed none); `account_id`; `allowlist` text[] DEFAULT `['*']`; jsonb `config`. PK (`station`,`account_id`). The `StationName` union is TS-only, via `$type`.
- `connectors` (added by `0010`) — `id`; `user_id` → `users.id`, so a connector is owned by the PERSON and no agent id appears on the path; `name`; `url`; `transport` plain text (`http` today, `sse` reserved), `ConnectorTransport` TS-only via `$type`; jsonb `config` = `{auth, createdAt, verified}`, ISO strings, no timestamp column. `unique(user_id, name)`. See Connectors above.

There is NO `keys` table since `0009`, no `credentials` column and no `whatsapp_auth` table. `allowlist` is a first-class column (relay-only, stripped from the train files); `owner` and every heterogeneous secret live in `config`, which materialize passes through to the train files. DB deps (`drizzle-orm`, `postgres`, dev `drizzle-kit`) live ONLY in `apps/mcp`; config is `apps/mcp/drizzle.config.ts`, generated SQL `apps/mcp/drizzle/`.

### Writers and loading

- `db/agent-admin.ts` (users + agents), `db/account-attach.ts` (accounts), `db/connectors.ts` (connectors) and `db/whatsapp-login.ts` are the ONLY writers. `db/materialize.ts` is read-only against the DB, and it never reads `connectors` — nothing about a connector is materialized to disk or to a train.
- `ensureUser` is `INSERT … ON CONFLICT DO NOTHING RETURNING id`, re-SELECTing the winner when a concurrent first login wins the race, so two simultaneous logins settle on one row and neither 500s.
- `createAgentForEmail` validates the name (`/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/`, trimmed, **never lowercased**), mints the key and inserts agent + key in ONE statement, with no duplicate-name check of any kind. It registers the key only when the daemon is not `METRO_AGENT`-pinned.
- **Keys are stored PLAINTEXT.** `GET /api/agents` re-serves the key to its owner, so hashing would break that and turn `authenticate()` into a DB lookup. Don't "fix" it in passing.
- No per-owner agent cap and no sign-in domain allowlist — sign-up is open to any verified Google account by design. Don't reintroduce `METRO_MAX_AGENTS_PER_OWNER` or `METRO_SIGNIN_DOMAINS`.
- `deleteAgentForEmail` **does not cascade into `accounts`**: an agent with rows is refused 409 and the owner detaches them first, so deleting an agent can never destroy a live station credential in one click. It deletes in one transaction (re-asserting `owner_id` in the WHERE) then `unregisterAgentKey(id)`, so the key 401s on the next request without a restart — evicting from the DB alone is not revocation. It never touches `users`.
- `materializeFromDb()` runs once at boot before `supervisor.start()`, writes the per-station account files (`writeSecure` 0600) and train stubs, and **throws on missing `DATABASE_URL` or an empty DB** — one path, fails loudly. Trains read those files; none opens a pg connection.
- `METRO_AGENT` (numeric id) restricts a daemon to one agent; must be a positive integer that exists or boot throws. Unset loads all — and since #129 several agents hold the daemon concurrently, so one daemon per agent is no longer required for liveness.
- xmtp config is `{privateKey}`; the legacy `{mnemonic, derive}` HD form is GONE and a row still carrying it fails validation at boot. `mnemonic`/`derive`/`seed` stay in the UI's `SECRET_KEY_PATTERN` redaction list so an unconverted row can never render its seed.

## Deploy & Ops

- **Merging to `main` auto-deploys to Fly.** Don't merge unfinished work. Land via PR; the repo squash-merges (`(#NNN)` suffix).
- **Every deploy is a real outage** — 40–90s observed, and it kills the GET stream of every connected MCP client permanently (see the ceiling above). Tell the user to reconnect metro afterwards.
- Fly app `metro`, region `iad` (`fly.toml`). `auto_stop_machines=false`, `min_machines_running=1`, `shared-cpu-1x`/1gb, `metro_data`→`/data`. Env: `HOME=/data`, `METRO_TRAINS_DIR=/app/apps/mcp/trains`, `METRO_HTTP_HOST=0.0.0.0`, `METRO_LOG_LEVEL=info`.
- **Single-writer XMTP:** only ONE instance may write the MLS inbox. A second burns the 10-install / 256-update budget, and exhaustion is a permanently dead inbox. This is why `min_machines_running=1` and machines never auto-stop. Never run a second prod writer.
- `HOME=/data` puts the MLS db3s on the mounted volume so they survive deploys — that durability is why XMTP stays on Fly.
- No Docker entrypoint script: `ENTRYPOINT` runs `bun /app/apps/mcp/src/server.ts` directly, and materialize generates the stubs. `acquireLock` reclaims a stale lock from an ungracefully-killed instance so a restart never boot-loops, while a genuinely-live metro still makes the second instance exit.
- **`DATABASE_URL` is the ONLY required Fly secret.** Optional: `METRO_PUBLIC_URL`, `METRO_AGENT`. Station secrets live in the DB. The channel allowlist is the per-account `allowlist` column, not an env var.
- Reconnect reality: the channel GET stream is held open by a 15s SSE-comment keepalive. On reconnect the relay replays from the bounded ring — best-effort, bounded to `BUS_BUFFER_MAX`, not guaranteed across a long disconnect.

## Removed — don't resurrect

`history.jsonl` and any on-disk journal/outbox · the Codex integration (#16) · the old read-only Monitor dashboard with ring-buffer replay, `/api/state` and claims (#40) · `METRO_MCP_HTTP_TOKEN` and every env bearer · the `keys` table (`0009`) · `GOOGLE_EMAIL_AGENTS` and any name-keyed grant · `METRO_CHANNEL_STATIONS` (it only ever subtracted, silently) · the LINE station · an MCP client in `apps/ui` (#113) · xmtp's `{mnemonic, derive}` config and the env `MNEMONIC`.

## Working discipline

- **Verify, then act.** Confirm claims against the code (rg/Read) before changing or asserting. Most "obvious" facts here have load-bearing exceptions.
- Don't flag code as dead without an `rg` search proving zero references across the workspace, including the exports map and the station registry.
- The full gate must be green before you propose a PR.
- Branch off `main`, open a PR, land via PR. For stacked PRs, beware `--delete-branch` deleting a dependent PR's base.
