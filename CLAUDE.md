# CLAUDE.md

The story behind these rules, with dates and incidents, is in `docs/HISTORY.md`. Search it before changing a load-bearing behaviour. Design notes: `docs/SETUP.md`, `docs/ISSUING-SERVERS.md`, `docs/MICROSOFT-365.md`.

## What Metro is

A relay between chat networks (XMTP, Telegram, Discord, WhatsApp, Threema) and Claude Code, run on the user's own machine ("box") by `metro serve`. One daemon serves MCP over HTTP, a model gateway and an admin API, and supervises one subprocess ("train") per station.

Inbound: network message, station, in-process bus, MCP channel notification. Outbound: agent tool call, station verb, network. `api.metro.box` (`apps/api`, Fly) runs no station: sign-in, the agent list, AWS launches, `/health`. The page `https://metro.box` (`apps/ui`, Netlify) manages one box at a time. **Every daemon is local. There is no hosted mode.**

**One box is one agent.** The daemon creates `~/.metro/agents/agent.json` (`{version: 1, id, name?, key, stations[]}`; an old file's `owner` and `connectors` keys are ignored and dropped at the next save) at first boot. A second agent, or an import of another agent id, is 409. The name a person sees is the box's row on metro.box.

**Vocabulary:** the page says "channel"; code, files, wire and this document say `station`. Do not rename `station` identifiers, JSON keys or `metro://<station>/…` lines without a migration: they are on-disk and wire contracts.

## Monorepo layout

Bun workspaces, `bun@1.4.0` minimum (Bun 1.3.9 leaks the upstream socket of an aborted relayed stream). `ci.yml` and the Dockerfile pin the same version.

- `packages/core` (`@metro-labs/core`): the kernel every process shares (`log`, `events`, `ids`, `protocol`, `lines`, `stations/*`, …). **It imports nothing from the workspace, has no HTTP and no policy, and is the only workspace package a station may import.** Import it through its exports map (`@metro-labs/core/log`, `/events`, `/stations/types`, …).
- `packages/http` (`@metro-labs/http`): request auth and answers (`cors`, `api-http`, `api-error`, `workos-token`, `return-to`, `mode-api`). Imports only `core`. It exists so heavy crypto and HTTP deps never reach a station process.
- `apps/api` (`@metro-labs/api`, api.metro.box): WorkOS sign-in, organizations and members, the agent list, the AWS launcher, the operator pages, `/health`. The only Postgres in the repo. No station, no MCP, no gateway.
- `apps/daemon` (`@metro-labs/daemon`, what `metro serve` runs), one folder per domain:
  - `boot/` (boot, crash guard, paths, local owner), `routes/` (the HTTP server and mount order, `local-mode` which wires every API's deps, `bearer`, `threema-callback`).
  - `agents/` (agent file, key map, scope, accounts API, bundle), `stations/` (registry, attach, materialize, supervisor, train calls, runtime deps), `connectors/` (store, relay, OAuth, plugin sync, health, live tool list).
  - `mcp/` (MCP server at `/` and `/mcp`), `channels/` (bus events to `notifications/claude/channel`), `gateway/` (model gateway and Model API), `monitor/` (`/api/tail`).
  - `claude/` (transcripts, memory, settings, skills, setup, session watcher, login, plugin install), `terminal/`, `files/` (attachments, uploads), `net/` (tunnel), `server/` (control, machine, update, owner).
- `apps/ui`: the page (Vite, react-native-web, `@stage-labs/kit`).
- Stations: `packages/{xmtp,telegram-bot,telegram,discord-bot,whatsapp,threema,webhook}`. Each exports `.` (`src/station.ts`) and `./train` (`src/index.ts`).
- `packages/cli`: `@stage-labs/metro`, the CLI. `plugin/`: the Claude Code plugin (not a workspace package).

**Import law** (convention, reviewed by hand; `bun run madge` only fails on circular imports, it does not check domains):
- A domain imports `core`, `http` and other domains only at named seams: `agents/scope`, `stations/registry`, `stations/train-call`, `files/attach-serve`.
- `agents/` and `stations/` never import `mcp/`. Their deps are injected from `boot.ts`.
- Nothing imports `routes/` except `boot/`. Known exceptions today: `stations/materialize.ts` and `stations/supervisor.ts` import `trainsDir` from `boot/paths`, and `mcp/index.ts` imports from `routes/http`.
- `mcp/` imports `channels/`, never the reverse.

**Station naming:** `telegram` is the user-account station (MTProto), `telegram-bot` is the Bot API one. Lines, account files (`telegram-bot-accounts.json`) and env vars (`TELEGRAM_BOT_*`, `TELEGRAM_*`, `DISCORD_BOT_*`) follow these names. There is no LINE station; a leftover `line` account crashes `materialize.ts`.

## The CLI and publishing

- **`@stage-labs/metro` (`packages/cli`) is the only published package.** Everything else is `private: true`.
- It ships `dist` only, `bin.metro` is `dist/cli.js`, `engines.node >= 22`. **It uses no Bun API and its shebang is `node`.** Do not import `Bun.*` there. It has no `dependencies`.
- **Publish only as a prerelease on the `beta` dist-tag.** A `latest` publish would roll out to every box. `publishConfig.tag` is `beta`, and the workflow still passes `--tag beta` explicitly.
- Publishing is the manual `Publish @stage-labs/metro` workflow (`.github/workflows/publish-cli.yml`, `dry_run` input). It builds first, since `dist` is gitignored and a bare `npm publish` ships an empty package. `NPM_TOKEN` must be an npm automation token (a personal one gets 403 for 2FA).
- **`metro update` picks the highest version across all dist-tags, never `latest`** (`latest` is stuck at `beta.0`, so trusting it would downgrade). `newestOf` and `isNewer` are pinned in `test/version.test.ts`.
- Commands: `serve`, `service install|uninstall|status`, `stop`, `tail <agent-id>`, `whoami`, `claude [args...]`, `update [--check]`, `version`. The CLI talks only to the daemon on this machine.
- **`metro serve`** runs the daemon from a per-user runtime store (`~/.metro/runtime`, `METRO_RUNTIME_STORE` overrides) through a one-line shim `<store>/server.ts`, so a moved daemon package never strands a box. It always uses Tailscale Funnel and refuses to start without a running Tailscale. `--owner` (an organization id) is needed until `<agents dir>/.owner` exists.
- Daemon exit 75 means respawn (Update, Restart). Exit 76 means park (Stop): the parent holds the port with a stub answering `/api/mode` with `stopped: true` and `POST /api/start`.
- **The runtime store installs only the vendor SDKs of the stations in use.** `prepareRuntime` copies the staged sources and runs `bun install` only when the generated `package.json` changed. A station attached later installs its SDK from the daemon side (`stations/runtime-deps.ts`). Both writers produce byte-identical `package.json` files; keep them so.
- **The sync code that runs is the long-lived PARENT's, not the new package's.** A box whose `metro serve` started on an old CLI keeps old sync logic through every update until `systemctl restart metro`. The page's Restart only restarts the child.
- **`metro claude` is a verbatim passthrough.** It prepends the channel flag, `--permission-mode`, `--system-prompt-snapshot off`, `--mcp-config <0600 temp file>` and `--append-system-prompt` (when set), then the user's args unchanged, so a user flag wins.
- When the daemon is serving, it sets `ANTHROPIC_BASE_URL` to the gateway and `ANTHROPIC_CUSTOM_HEADERS=x-metro-key: <key>`. **It never sets `ANTHROPIC_AUTH_TOKEN` while Claude Code has its own login**, because a credential variable replaces the claude.ai login. With no login at all it uses the agent key as a stand-in credential.
- Bypass mode under root sets `IS_SANDBOX=1`, only when uid is 0 and the variable is unset, because Claude Code refuses bypass as root otherwise. `metro claude` also seeds `tengu_harbor` into Claude Code's cached flags and marks onboarding done: both are unsupported hacks that a Claude Code release may break.
- `metro tail` prints only event JSON on stdout (status lines go to stderr) because Monitor treats each stdout line as an event.

## The Claude Code plugin (`plugin/`)

- The plugin ships inside the npm package. `stage-runtime.mjs` stamps the staged `plugin.json` with the CLI version, and the daemon installs or updates it at boot (`claude/plugin-install.ts`) from `<store>/marketplace` as a directory marketplace.
- **`plugin/.claude-plugin/plugin.json` `version` must move with any change under `plugin/`.** Claude Code caches by version, so changed code under an unchanged version never reaches a box.
- **The manifest must not name `hooks` or any path that does not exist** (`skills` included). Claude Code loads `hooks/hooks.json` by itself; naming it counts as a duplicate and the plugin fails to load its MCP servers. `test/plugin-manifest.test.ts` pins it.
- `plugin/` is committed plain-Node `.mjs`, no build, no deps. `bin/guard.mjs` is a PreToolUse guard (orchestrator-only main thread; unparsable payload is denied). `bin/session-start.mjs` injects the orchestrator rules. `plugin/orchestrator.md` is the one source of those rules.
- **The daemon writes each connector as its own server into the plugin's `.mcp.json`** (`connectors/plugin-sync.ts`), in place, never by rename. It also writes `<store>/marketplace/plugin/.mcp.json`, because a directory-marketplace plugin loads from its source folder, not the cache.
- Entries carry no credential: `headersHelper` runs `bin/metro-plugin.mjs headers`, which prints `Bearer <agent key>`.
- **After a connector is added, removed or renamed, the user must run `/reload-plugins --force`.** A plain reload keeps the cached list. Tool changes inside a connector are live already.
- Relay urls in `.mcp.json` are always loopback (`loopbackBase()`), never the public address.

## The gate and tests

- `bun install`. CI and Docker use `--frozen-lockfile`: **commit `bun.lock` after any dependency change.**
- **Before any PR: `bun run build && bun run typecheck && bun run lint && bun run knip && bun run madge && bun run test`, all green.** Test the gate's exit code before committing or pushing.
- Local run: `bun apps/daemon/src/server.ts`. Prod runs TS from source; `dist/` is built only by the gate.
- Tests set `DYLD_FALLBACK_LIBRARY_PATH=/usr/lib` (xmtp bindings on darwin) and `METRO_STATE_DIR="$(mktemp -d …)"`. Run the whole suite; never assert an exact test count.
- **Tests that boot an HTTP server pick a port in 10000 to 29999**, below Linux's ephemeral range. Port 0 cannot be requested (`webhookPort()` treats 0 as unset).
- **Every test that materializes trains must point `METRO_TRAINS_DIR` at a temp dir in `beforeEach`**, or it writes stubs into the checkout. The default `trainsDir()` is `apps/daemon/trains` (gitignored), never `~/.metro/trains`.
- turbo `test` depends on `^build`, so a core edit reruns station tests.
- **Remove agent worktrees under `.claude/worktrees/` once merged** (`git worktree remove`). Lint scans them, and their own `node_modules` make ESLint fail with `could not find plugin "@typescript-eslint"`.

## Coding conventions (hard, enforced by `@stage-labs/config`)

- **No comments in source. None.**
- **No escape hatches:** no `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, or `any` casts to dodge types.
- **No floating promises, and `void p` is a lint error** (`ignoreVoid: false`). Every promise is awaited or ends in a `.catch()` that logs.
- `max-lines` (400) and function-length caps: split files instead of suppressing.
- Strict TS, ESM, import specifiers carry explicit `.js`.
- Throw real errors; surface with `errMsg` and `TrainError`. Never swallow.
- Log through the shared `log`, never `console`.
- **Inline style object literals in JSX are a lint error.** Use kit `Box` props, or a named constant (`SHRINK`, `GROW` in `theme.ts`).
- Style for prose and commit messages: conventional commits (`type(scope): subject`), no em dashes, plain English.

## Architecture invariants

### Bus, stations, trains

- **The bus is an in-memory ring (`BUS_BUFFER_MAX` 500), not a journal. Do not add an on-disk journal or history.** `channels/relay.ts` replays missed events on rebind, best effort.
- Stations are wired through `stations/registry.ts`; core dispatches over station defs. No per-network branching in core. Capabilities are declared on the `Station` (`hasAccounts`, `hasTrain`, `profileFields`, `readsProfiles`, `resolvesSenders`, `claimsName`, `attachmentMode`) and read, never branched on by name.
- `hasAccounts` and `hasTrain` are independent. `webhook` is `true`/`false`: no train, accounts read in-core, and `list_members` refuses it.
- A train call line longer than `STDOUT_LINE_MAX` (4 MiB) is dropped by `drainLines`. That is why no base64 ever crosses the train pipe: inline data lands in a temp file first.
- `materializeFrom` prunes stale stubs at first boot too, since the supervisor spawns every `*.ts` in the trains dir. A stub is rewritten only when its content changes.
- A disabled account (`stations[].enabled: false`) stays in the agent map but not in the account file, so its train does not run it. Toggling goes through `syncStations`; an allowlist change only reloads the maps (no train restart).

### Never fatal

- **Nothing in the relay path may kill the daemon.** A notification failing because a client left is normal.
- Three layers, keep all: the fallback timer `.catch()`es and logs; `ChannelRelay.enqueue` ends its chain with a `.catch()`; `boot/crash-guard.ts` installs `unhandledRejection` and `uncaughtException` as the first statement of `boot.ts`.
- Before `markDaemonReady()` a crash exits 1 (visible crash loop); after it, errors are logged and counted.
- The fatal path writes with `writeSync(2, …)` (`logFatalSync`), because pino's async destination is truncated by `process.exit`.
- Keepalive `res.write`s are guarded and close the stream on failure.
- Pinned by `test/never-fatal-notify.test.ts` and `test/crash-guard.test.ts`.

### Identity, sessions, scope

- **The agent key is the only credential for `/mcp`, the relay, the gateway, uploads and `/api/tail`.** `authenticate()` checks the key map only (`agents/keys.ts`, SHA-256 of the key to agent id, no plaintext). A daemon with no key is closed, not open.
- **The agent key never leaves the box and no API returns it to the page.** `GET /api/agents` and the bundle carry no key; a restore keeps the key on disk. The key is needed because Funnel delivers internet requests from loopback.
- There is no key reset. Recovery: a new `key` in `agent.json`, then a restart.
- `allowedAgents()` is the one place turning an identity into a `Set`; it never returns `undefined`. The only identity is `{kind: 'agent', agentId}`.
- **Scope by agent id, never by name.** Names are not unique; a name comparison in an auth path is a cross-owner leak that is not a type error.
- **One MCP session per box** (`mcp/session-slot.ts`): a box runs one agent, so the daemon holds one `McpSession` (its server, transport, stream, event store, relays and bus subscription). An `initialize` closes the current one and opens a new one. A request with no session id uses the current one. An unknown session id is adopted (a client that outlived a daemon restart), never refused. `test/one-session.test.ts`.
- **The replay ledger belongs to the slot, not the session**, so a message that arrived while the agent was away is delivered after a reconnect and after a full re-initialize.
- An adopted session is told the tool schema moved (on the GET stream or inside a `tools/call`); `tools/list` settles it silently, since notifying there loops.
- **A client that is neither streaming nor calling cannot be reached.** After any daemon restart or deploy, tell the user to reconnect `/mcp` or restart the client.

### One scope predicate for every egress (`agents/scope.ts`)

- `lineTargetDenied` resolves `args.line` and also any `args.account` override (stations resolve `account ?? line`). `stationFullyScoped` covers calls with no line.
- **`eventInScope` fails closed.** An account-station line whose account maps to no agent goes nowhere; an unparsable line reaches nobody. The one carve-out is by station: a station with no accounts (`metro://claude/…`) reaches every authenticated tail. Do not remove that carve-out.
- **Four egresses share one case table** (`test/egress-scope-matrix.test.ts`): channel live, channel bus replay, SSE resumption, monitor tail. **Add any new egress to that table.**
- **SSE resumption re-checks every frame that names a line** (`replayEventsAfter` takes the reconnecting scope as a required option); a frame with no line (a response, a tool list notice) replays. Keep both this gate and the relay gate.
- The channel delivers only while a GET stream is attached. Otherwise the event is withheld, not dropped, and the bus ring replays it when a stream comes back.
- `permission-relay.ts` re-checks the line with the session's scope before pushing an approval prompt (it contains tool input).

### Human in the loop

- **`PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i` is a contract with the relayed prompt's id format. Change both sides or neither.**
- **A reply counts only on the line the prompt was sent to** (`pendingPermissions` maps id to line). Only `msg` events are checked, so a webhook body can never answer a prompt.
- A `msg` with blank text and no attachment is dropped by the relay.
- `addressed` (`direct`, `mention`, `reply`) is decided in core (`channels/addressed.ts`) from facts stations report (`is_private`, `mentions_self`, `reply_to_self`) plus the relay's memory of ids it sent (`SENT_IDS_MAX` 2000).

### Attachments and uploads

- **Inbound:** a station emits `attachmentSaved` or `attachmentFailed` (with `reason`), both through one correlator (`InboundRelay.mediaCtxFor`). A failure note has no url and no path.
- `saveStreamToCache` streams to `.part` with a running size check and renames on success.
- **`/attach` is scoped by the owning agent.** The `?token=` is a per-attachment grant (`.grant` sidecar), never the agent key; access is that grant or a caller whose scope holds the owner. **Everything else is 401, including a cache-shaped name that does not exist; do not turn it into 404** (that would be an existence oracle). The only 404 is a name that is not cache-shaped.
- **Outbound sources: exactly one of `upload`, `data`, `url`, `path` per attachment.** Zero or two is an error. `path` is on the daemon host, `url` must be public, `data` is for tiny files.
- `MAX_INLINE_BYTES` (8 MiB) is set so it errors before `MCP_BODY_MAX` (32 MiB) answers a bare 413; raise both together. base64 is validated strictly. Inline and url bytes go into a per-attachment `mkdtemp`, never `attachDir()`, cleaned in a `finally`.
- **Uploads** (`files/upload-*`, `mcp/upload-tool.ts`): `create_upload` mints a slot and a command; bytes go over HTTP (a shell step is unavoidable). Slots live in `uploadDir()`, 30 min TTL read on every lookup, reaper every 60 s. 64 MiB per file, 512 MiB live total. Anything not authorized is a flat 404 (an upload id is a capability). The PUT url names the daemon that minted it.
- **An over-size chunked upload DRAINS (capped at 2x), it does not throw**: throwing destroys the socket in Bun and the client hangs. `streamToSlot` removes its own `.part` on failure.
- A send does not consume an upload, so a retry after a timeout works.
- **Outbound reporting is derived, never asserted.** `assertDelivered` compares labels to `atts.length` on every path; fewer labels is an error. **Each station builds its label list inside the send loop, after each push resolves, never by mapping the input.** Add every new station to `test/send-attachment-honesty.test.ts`.

### Connectors and the relay

- A connector is a verified bookmark for a remote MCP server (`<agents dir>/connectors.json`, 0600). Every agent holds every connector. Names are unique (409) because a name is the server key.
- **The relay (`/relay/<id>`) strips the caller's key before anything goes upstream** and injects the vendor credential per request. Only `accept`, `content-type`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id` pass through.
- **Status discipline: the daemon's 401 means only the daemon's own credential.** An upstream 401/403 gets one forced refresh and one retry, then **424** (and the connector is signed out). A remote 401 during verify is the daemon's 400. Upstream 3xx is refused (502). A row with no credential forwards bare.
- Client disconnect aborts upstream on `res` close and `res.socket` close, guarded by `!res.writableEnded`, never on `req` close. Token refresh is single-flight.
- **`parseConnectorUrl` is a security boundary**: http or https only, no `user:password`, no fragment. Any host is allowed, loopback and private included, since the daemon runs beside the servers it connects to. Every request uses `redirect: 'manual'`. Raw `fetch`, never the SDK `Client`. **No stdio connectors, ever.**
- No API returns a connector credential to the browser (`connectorPayload` carries no secret).
- OAuth: `prepareOAuth` (discovery and registration) runs before any row is stored. `GET /api/connectors/callback` is unauthenticated, keyed by single-use `state`.
- One MCP HTTP helper: `mcpPost`, `payloadOf`, `INITIALIZE` and `authHeaders` in `connectors/verify.ts` serve verify, the live tool list and the relay target; `refused()` lives in `connectors/url.ts` only.
- Errors carry the underlying cause (`connectors/reach.ts`): the relay's error body is what Claude Code shows under `/mcp`.

### Sign-in and ownership (WorkOS)

- The page signs in through api.metro.box with WorkOS (Google, Microsoft, GitHub). Zero cookies: the page keeps the tokens and sends `Authorization: Bearer` to metro.box and to every box.
- **The owner check lives in one place:** `routes/bearer.ts` `installBearerSessions` refuses a token for another organization with 403 (`test/bearer-session.test.ts`). The agent, account, connector, Claude, model, server and terminal APIs only check that a session exists, plus `requireAdmin` where listed. There is no per-API `authorize` hook and no `?project=`: the daemon ignores a `project` query and `/api/mode` keeps its `project` field only for old pages.
- **A box verifies the token offline** (`packages/http/src/workos-token.ts`, RS256 against the WorkOS JWKS cached at `<agents dir>/.jwks`). **The owner is the organization: the token's `org_id` must equal `.owner`**, else 403.
- `--owner` from a service unit never overwrites an organization owner in `.owner` (`boot/local-owner.ts`).
- Single-path owner routes (`server/*`, `terminal/api`) go through `sessionRoute` in `http/api-http` (path and method match, OPTIONS, 405, session, admin by method, `apiFailure`). One-time single-use tokens with a TTL (OAuth `state`, terminal tickets) are `ticketStore` from `core/tickets`.
- **`requireAdmin` gates:** stop and restart, the update POST, the Terminal, agent delete, the bundle and restore, `POST /api/owner`, and non-GET Claude `login`, `session`, `version`, `setup` routes. Keep the `ADMIN_ONLY` pattern in `claude/api.ts` matching the full path.
- metro.box: the launch, server list and admin APIs take the bearer only; the owner is always the signing organization, never a value from the body. Operator pages check the stored email against `OPERATOR_EMAIL`. Waitlist status is checked at the callback and on every refresh.

### Export and import

- A `.metro` file is gzipped JSON sealed with a **passphrase** (`apps/ui/src/export/passphrase.ts`: PBKDF2-SHA256 600k, AES-256-GCM, envelope `v: 2`). A `v: 1` wallet-sealed file is refused.
- The agent id and key are never in the file; import fills in the local agent's. Import modes `append` and `overwrite` never delete what the file does not mention.
- `GET /api/agents/<id>/bundle` and `POST /api/agents/restore` move the plaintext bundle between the page and its own box only, never to metro.box.

### Stations

- **XMTP single writer:** only one process may write an MLS inbox. A second burns the 10-installation budget. So `metro serve` refuses a second instance, and two boxes must never run the same agent. The db3 path is home-relative.
- XMTP accounts are ZeroDev Kernel smart accounts on Base (`smart: true`); older plain-key accounts cannot hold a name. A name claim is page-only and permanent.
- **WhatsApp:**
  - `connectionReplaced` is terminal, so a double run does not loop into a 463 time lock.
  - **Only `tctoken` and `lid-mapping` are persisted** (`token-store.ts`), because a 1:1 send without the contact's token gets `ack error 463`. Do not persist other Signal key types: `creds` is never written back, so half a Signal state is worse than none.
  - **A message key is never synthesized.** Keys come verbatim from a per-account LRU filled from every upsert and every send; a group key needs the original `participant`. An unknown message fails loud (`whatsapp_unknown_message`).
  - **The send verdict is read from `sock.ws` (`CB:ack,class:message`)**, which bypasses Baileys' buffered emitter. 463 throws `whatsapp_account_restricted`. No ack in the window counts as sent.
  - `sock.end()` must be awaited. Never run a second Baileys client on live credentials to test.
- Telegram user account (`telegram`): the session is a full-account secret, single writer, ToS risk.
- **Threema:** Gateway ID in end-to-end mode only; the private key never leaves the train. The callback checks the MAC first; a down train answers 503 (Threema retries), a refusing train 400 (it stops).
- **Webhook:** the url names `webhookId` (random digits), never `account_id`, which would leak the agent id. The whole url is the credential; anything else is a flat 404. The route must stay before the monitor router. **Attaching a webhook is refused on a local daemon today** (400, it needs a public url), so the code path is dormant.
- **The daemon checks a call's verb against the station's `messageVerbs`**: `dispatchMessageTool` refuses an undeclared verb before any train call, naming the verbs the station supports (`test/message-verb-gate.test.ts`). Trains do not refuse verbs themselves. A train action that no declared verb, group op, tool, profile or account route names is dead code: delete it.
- Discord-bot verbs: all seven and group ops. Voice was removed. An inbound Discord edit reaches `metro tail` only; the channel relay routes `msg`, `react` and `system`.
- XMTP has no push: no FCM, no `METRO_CTRL:` control DMs. Every inbound DM goes through the allowlist. Its own tools are the Stage ones (`close_channel` with `removeInboxIds`/`removeSelf`, `set_channel_metadata`, labels); there is no `create_channel`, an agent uses `create_group` then `set_channel_metadata`.
- **A train builds its events with `@metro-labs/core/stations/train-events`** (`emitInbound`, `reportAttachment`, `attachmentSavedEvent`, `attachmentFailedEvent`, `selfUri`). Never hand-build an `attachmentSaved` envelope; it carries both `attachmentPath` and `localPath` because the daemon reads `attachmentPath ?? localPath`. The boot banner and empty-accounts exit are `announceAccounts` (`core/stations/train-boot`); a client-per-account train (telegram, whatsapp) is one `runClientTrain` call. Account configs carry no `owner`.
- **Receiving is never held for a profile lookup**; anything costing a network call is behind the `get_profile` tool.

### Claude Code on the box

- `claude/files.ts` reads Claude Code's own files under `METRO_CLAUDE_DIR`, `CLAUDE_CONFIG_DIR` or `~/.claude`. Names are validated with regexes before a path is built; the URL is split before decoding.
- **Settings and skills are resolved by id through their own listing, never by building a path.** Writes go through `writeAtomic` (`core/secure-fs`: temp file then rename, keeps the file's mode, 0644 for a new one, or the mode passed in; never `writeSecure`, which would force 0600), refuse non-object JSON (400) and a stale `seenAt` (409). Skills list `~/.claude/skills` only; a symlinked skill folder counts, and deleting it removes the link only.
- **Setup applied at boot** (`claude/setup.ts`): the worker agent and orchestrator skill are written when missing, and refreshed only when their sha256 is one metro shipped.
- **Whenever `WORKER_AGENT` or `plugin/orchestrator.md` changes, add the previous text's sha256 to `PRIOR_WORKER` or `PRIOR_SKILL`**, or boxes keep the old copy. Privacy env is merged into `~/.claude/settings.json` (Claude Code's auto-updater is off as a result; the Harness page's Update runs `claude install latest`).
- **The session watcher** (`claude/session.ts`) keeps tmux session `metro` running `metro claude` (`-c` when a conversation exists), and restarts it after a metro update or a mode or system-prompt change, since flags load at session start.
- The Claude login drives `claude auth login --claudeai` in a pty. **metro never re-implements claude.ai OAuth and never reads the credential.**

### The model gateway (`apps/daemon/src/gateway/`)

- Claude Code on the box talks to `/gateway`; auth is the agent key in `x-metro-key`, never `Authorization` (that holds Claude Code's own login).
- **The route is read per request from `<agents dir>/model.json` version 2** (`{route, connections[]}`), so a change applies on the next request. Several connections per provider are allowed. A version 1 file is migrated and written back at once (ids must be stable). No connection means plain Anthropic passthrough.
- Usage, served line and token tallies are keyed by connection id. **Codex and Gemini token refresh state is per connection**, single-flight, shared by the gateway and the Model API.
- **The Anthropic passthrough is verbatim** (path, query, headers except hop-by-hop, `accept-encoding`, `x-metro-key`; body bytes as received). Re-serialize only when metro changed something. A stored API key swaps `authorization` for `x-api-key` and drops OAuth betas; small (haiku) models pass through unpinned.
- **Effort policy** (`gateway/effort.ts`): main thread `low`, subagents `max`, chores untouched. Subagents are detected by `x-claude-code-agent-id` or `cc_is_subagent=true`. Only an effort the client sent is replaced. OpenRouter and Gemini cap at `high`. Anything metro reshaped is retried once as the client sent it on a 400.
- Disabled thinking is dropped for models that cannot run without it (`withThinkingFor`) and on OpenRouter. Thinking blocks that no longer match are dropped via `block_binding` on the Anthropic route.
- **A provider refusing the stored credential is relayed as 403, never 401** (a 401 makes Claude Code discard its own login).
- Every provider stream has an idle deadline (`METRO_GATEWAY_IDLE_MS`, 5 min) and non-Anthropic routes get 25 s pings.
- Codex and Gemini go through one pipeline, `gateway/subscription.ts` (per-connection token slots with single-flight refresh, `reach`: a 401 gets one refresh and one retry, `relayTranslated`, `answerWhole`). Every non-Anthropic stream shares `relayFrames` in `forward.ts` (pings, usage scanner, idle deadline). A new subscription provider supplies a `TokenSource`, its `send` and a translator.
- **Codex (ChatGPT subscription) and Gemini (presenting as Google Antigravity) are unofficial clients** that can be cut off at any time; OpenRouter is the supported path. Codex lists models by `CODEX_VERSION` (`METRO_CODEX_VERSION` overrides).
- **`KNOWN_CLAUDE` in `gateway/provider-models.ts` is hand-written: extend it when Anthropic ships a model**, since a keyless box cannot list models.

### Monitor transport

- Only `GET /api/tail` (live SSE, no replay), same auth and scope as `/mcp`. **Keep it minimal: no history, no ring buffer, no train-call route.**

## HTTP surface

### The daemon (one port, `METRO_WEBHOOK_PORT` or 8420)

**Mount order is load-bearing: the monitor router claims all of `/api/*`, so anything under `/api/` must be mounted before it** (`handlePreMcpRoutes` in `routes/http.ts`).

| Route | Auth | Note |
| --- | --- | --- |
| `GET /health` | none | `{status, version, uptime}`. Never gate or break it. |
| `/gateway/v1/messages`, `/count_tokens`, `/models` | agent key in `x-metro-key` | Model gateway. `HEAD /gateway/api/hello` is open. |
| `GET /api/mode` | none | `{mode: 'local', owner, version}`, CORS with private-network allowed. `stopped: true` while parked. |
| `GET /api/session` | bearer | `{subject, role}`, the page's boot gate. |
| `GET /api/agents`, `/api/agents/<id>/accounts…` | bearer | The one agent as `{id, name, connector_ids}` (no key, no delete), account attach, allowlist, enable, senders, resolve, XMTP name. |
| `GET /api/agents/<id>/bundle`, `POST /api/agents/restore` | bearer, admin | Plaintext bundle for the page's own export. |
| `/api/connectors…` | bearer | Connectors, OAuth, live tools. `GET /api/connectors/callback` is open (single-use state). |
| `/api/claude/…` | bearer (writes on login/session/version/setup are admin) | Transcripts, memory, settings, skills, setup, session, version, login. |
| `/api/model…` | bearer | Route, connections, Codex and Gemini sign-in. Never returns a key. |
| `GET /api/server` | bearer | Machine facts. |
| `POST /api/stop`, `/api/restart`, `/api/update` | bearer, admin | Exit 76 or 75 after answering; 400 if not started by `metro serve`. |
| `POST /api/owner` | bearer, admin | Hand the box to another organization. |
| `/api/terminal`, `POST /api/terminal/tickets`, `ws /api/terminal/<ticket>` | bearer, admin, then a one-time ticket in the path | tmux in a Bun PTY. Ticket in the path because Funnel strips query strings on upgrade. |
| `/api/uploads…`, `/attach` | agent key, upload ticket or attachment grant | See attachments. |
| `/relay/<connector-id>` | agent key | MCP relay. |
| `POST /api/webhooks/<id>/<token>` | the url | Webhook inbound (attach currently refused). |
| `POST /api/threema/<id>/<token>` | the url, then MAC | Threema callback. |
| `GET /api/tail` | agent key | Monitor. |
| `/`, `/mcp` | agent key | MCP. |
| `POST /api/start` | none | Only on the parked stub from `metro serve`. |

### api.metro.box (`apps/api`)

| Route | Auth | Note |
| --- | --- | --- |
| `GET /health`, `GET /api/mode` | none | |
| `/api/auth/*` | none, then bearer | WorkOS login, callback (handoff code in the hash), exchange, refresh, me, logout, organizations, switch, account. |
| `/api/organization…` | bearer | Members, invitations, rename, slug. Writes are admin. |
| `/api/servers…` | bearer | The organization's agent list, rename, slug, avatar (checked PNG only), move. |
| `/api/launch…` | bearer | Launch a box on AWS, status, boot log (Tailscale keys redacted). |
| `/api/admin/*` | bearer, operator email | Users, status, organizations, agents. |

## Database (`apps/api` only)

- **Postgres lives only in `apps/api`.** The daemon has no `drizzle-orm`, `postgres` or `drizzle-kit`.
- Tables in `apps/api/src/db/schema.ts`: `agents` (the box list: owner organization, host, name, slug unique per owner, avatar, launch fields), `users` (login record, avatar, status), `organizations` (id, unique slug).
- Config `apps/api/drizzle.config.ts`, SQL in `apps/api/drizzle/`. **Migrations are hand-written with a journal entry**; `drizzle-kit generate` cannot be used. `test/migrate.test.ts` pins journal integrity. The 35 historical migrations were squashed into `0000_baseline.sql` on 2026-09-23, stamped `when: 1788557725042`, the last migration production had applied, so the migrator skips it there and builds the three tables on a fresh database (checked on a throwaway Postgres both ways). **A new migration must carry a `when` greater than that**, or production never runs it; the test pins it.
- **Migrations run through Fly's `release_command` (`bun --filter @metro-labs/api db:migrate`), never at boot.** A failure aborts the deploy and the old machine keeps serving.
- **The Dockerfile must use `CMD`, never `ENTRYPOINT`**: `release_command` replaces `CMD` only, so an `ENTRYPOINT` would boot a server in the release machine that never exits.
- **`drizzle-kit` is a runtime dependency** of `apps/api`, because the image installs `--production --filter @metro-labs/api`. The filter is load-bearing too: it keeps station SDKs and daemon source out of the image.
- Ids everywhere are 11-char base64url (`core/ids.ts`), opaque. Unique-violation checks go through `db/errors.ts` `isUniqueViolation`, which walks `cause`.

## The page (`apps/ui`)

- Addresses are `#/<org slug or id>/<agent slug or id>/<page>`; `#/settings`, `#/login`, `#/auth/<code>`, `#/admin…` are global. A first segment with a dot or colon is a box host (the link a daemon prints) and is added to the list, then rewritten. A bare slug is never a box address.
- **Not an MCP client.** `apps/ui/src/mcp/client.ts` must not come back.
- A feature that needs a newer daemon is gated with `olderThan(version, X_SINCE)` and shows "Update first"; an unknown version never hides a feature. The only gate left is `CONNECTIONS_SINCE` (beta.165, the Model page and the agent home). Do not add a gate for a version below what the page can talk to at all (beta.138, WorkOS bearer).
- **Every colour comes from the kit palette via `theme-mode.tsx`.** No hand-picked hex or `color-mix`. Exceptions: the pairing QR and favicon tiles pin light tokens, and the build dot's pure white/black.
- **A navigable thing is an `<a href>`**, its href from `routeHash`, and its click handler lets modified clicks through (`opensElsewhere`).
- **`.kebab` has no border** (no `box-sizing` reset, so a border breaks the 40px alignment with the kit Button). The kit Button sets `alignSelf: flex-start`; override through its `style`.
- **One copy of the shared pieces:** `DeleteMenu` (kebab plus typed confirm; `useConfirm` and `ConfirmDialog` for a button trigger) for every delete, connectors included; `useSave` and `SaveField` for "edit a field, then Save"; `useBoxQuery(key, fn, opts)` and `refresh(client, key)` in `api/queries.ts` for every query against a box, which always put `daemonBase()` in the key; `api/read.ts` for reading an answer (`isRecord`, `recordOf`, `filled`, `str`); `SLUG_RE` and `RESERVED_SEGMENTS` in `auth/org-segment.ts`.
- **Connect (connector OAuth) opens its tab synchronously on the click**, then sets its location; a `window.open` after an `await` is popup-blocked.
- **Fonts: Calibre only** (Medium and Semibold in `public/fonts`, not MIT-licensed, do not copy elsewhere). No mono font, no `variant="mono"`. **Every text size goes through `typeSize` / `TYPE_SCALE`**; a bare `font-size: <n>px` in `index.css` fails `test/fonts.test.ts`.
- `@types/qrcode` is a needed devDependency although nothing imports it (the kit's source does); it is in knip's `ignoreDependencies`.
- Terminal: xterm.js with `addon-fit` and `addon-clipboard`; a plain left press is re-dispatched with Alt and Shift so xterm keeps the selection local (`terminal-select.ts`). A resize must be followed by `SIGWINCH` to the child; a malformed resize frame is ignored, never defaulted.

## Deploy and operations

- **Merging to `main` auto-deploys `apps/api` to Fly** (app `metro`, region `iad`, no volume). Do not merge unfinished work. Land via PR (squash merge). `DATABASE_URL` is the one required secret, plus WorkOS and the launcher's AWS and Tailscale secrets.
- The page deploys to Netlify.
- Boxes run `metro serve` under systemd (`metro service install`). `systemctl stop metro` keeps it stopped; `metro stop` alone is restarted by the service.
- **One public address per box: Tailscale Funnel** (`net/tunnel.ts`). The node name `metro-<6 chars>` lives in `<agents dir>/.node`; a pre-written valid name is kept. An existing Funnel that answers with this owner is adopted and watched.
- After a deploy or daemon update, **tell the user to reconnect `/mcp`**, and after a connector change, to run `/reload-plugins --force`.
- **Moving a box to another AWS region:** stop the instance, image the stopped disk, `copy-image`, `run-instances` with the same type and tags and no user data, then wait for `/api/mode` on the same Funnel address. **Keep the old instance stopped until terminated** (single writer). Then fix the `agents` row's `instance_id` and `launch_region` from inside the Fly machine.

## Removed: do not resurrect

- `history.jsonl` or any on-disk bus journal or outbox; the old read-only Monitor dashboard, `/api/state`, claims, and `/api/call/:train/:action` and `/api/health` on the monitor.
- Every env bearer (`METRO_MCP_HTTP_TOKEN`), the `keys` table, name-keyed grants (`GOOGLE_EMAIL_AGENTS`), `METRO_CHANNEL_STATIONS`.
- The LINE station; an MCP client in `apps/ui`; xmtp `{mnemonic, derive}` and env `MNEMONIC`.
- Google login, SIWE, the session JWT, `.session-secret`, the wallet sign-in (EIP-712 signature, derived identity, `POST /auth/identity`, identity registry) and wallet-sealed exports.
- Projects and members as a daemon concept, hosted station and connector rows, the hosted relay, runtime leases, `metro start`, `metro login`, pairing codes, the credentials file, `metro mcp`, `metro plugin`, `metro bedrock`, `/api/cli/*`, `/metro:refresh`.
- The hosted vault, Sync with Metro and Restore from Metro; the `vaults` table.
- The paste-ready `claude mcp add` command and the agent key reset.
- The cloudflared tunnel (quick or named); `METRO_MODE` and the hosted daemon branch; the `db/` folder in the daemon; the `@metro-labs/mcp` package name.
- The launch allowlist (`METRO_LAUNCH_OWNERS`) and per-identity launch cap.
- A plaintext credential table on metro.box.

## Working discipline

- **Verify, then act.** Confirm claims against the code before changing or asserting them. Many "obvious" facts here have load-bearing exceptions; `docs/HISTORY.md` holds the reasons.
- Do not call code dead without an `rg` proving zero references, including exports maps and the station registry.
- Branch off `main`, open a PR, land via PR. Run `bun run smoke` after a layout change.
