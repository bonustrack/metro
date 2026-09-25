# CLAUDE.md

The story behind these rules, with dates and incidents, is in `docs/HISTORY.md`. Search it before changing a load-bearing behaviour. Design notes: `docs/SETUP.md`, `docs/ISSUING-SERVERS.md`, `docs/MICROSOFT-365.md`.

## What Metro is

A relay between chat networks (XMTP, Telegram, Discord, WhatsApp, Threema, an Outlook mailbox) and Claude Code, run on the user's own machine ("box") by `metro serve`. One daemon serves MCP over HTTP, a model gateway and an admin API, and supervises one subprocess ("train") per station.

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
- Stations: `packages/{xmtp,telegram-bot,telegram,discord-bot,whatsapp,threema,outlook,webhook}`. Each exports `.` (`src/station.ts`) and `./train` (`src/index.ts`).
- `packages/cli`: `@stage-labs/metro`, the CLI. `plugin/`: the Claude Code plugin (not a workspace package).

**Import law** (convention, reviewed by hand; `bun run madge` only fails on circular imports, it does not check domains):
- A domain imports `core`, `http` and other domains only at named seams: `agents/scope`, `stations/registry`, `stations/train-call`, `files/attach-serve`.
- `agents/` and `stations/` never import `mcp/`. Their deps are injected from `boot.ts`.
- Nothing imports `routes/` except `boot/`. Known exceptions today: `stations/materialize.ts` and `stations/supervisor.ts` import `trainsDir` from `boot/paths`, and `mcp/index.ts` imports from `routes/http`.
- `mcp/` imports `channels/`, never the reverse.

**Station naming:** `telegram` is the user-account station (MTProto), `telegram-bot` is the Bot API one. `outlook` is a Microsoft 365 or Outlook.com mailbox. Lines, account files (`telegram-bot-accounts.json`, `outlook-accounts.json`) and env vars (`TELEGRAM_BOT_*`, `TELEGRAM_*`, `DISCORD_BOT_*`, `OUTLOOK_*`) follow these names. There is no LINE station; a leftover `line` account crashes `materialize.ts`.

## The CLI and publishing

- **`@stage-labs/metro` (`packages/cli`) is the only published package.** Everything else is `private: true`.
- It ships `dist` only, `bin.metro` is `dist/cli.js`, `engines.node >= 22`. **It uses no Bun API and its shebang is `node`.** Do not import `Bun.*` there. It has no `dependencies`.
- **Publish only as a prerelease on the `beta` dist-tag.** A `latest` publish would roll out to every box. `publishConfig.tag` is `beta`, and the workflow still passes `--tag beta` explicitly.
- Publishing is the manual `Publish @stage-labs/metro` workflow (`.github/workflows/publish-cli.yml`, `dry_run` input). It builds first, since `dist` is gitignored and a bare `npm publish` ships an empty package. `NPM_TOKEN` must be an npm automation token (a personal one gets 403 for 2FA).
- **`metro update` picks the highest version across all dist-tags, never `latest`** (`latest` is stuck at `beta.0`, so trusting it would downgrade). `newestOf` and `isNewer` are pinned in `test/version.test.ts`.
- Commands: `serve`, `service install|uninstall|status`, `stop`, `tail [agent-id]`, `whoami`, `claude [args...]`, `update [--check]`, `version`. The CLI talks only to the daemon on this machine.
- **`metro serve`** runs the daemon from a per-user runtime store (`~/.metro/runtime`, `METRO_RUNTIME_STORE` overrides) through a one-line shim `<store>/server.ts`, so a moved daemon package never strands a box. It always uses Tailscale Funnel and refuses to start without a running Tailscale. `--owner` (an organization id) is needed until `<agents dir>/.owner` exists. **A wallet `--owner` is accepted and ignored, never refused**: every installed systemd unit and launchd plist still carries the wallet it was installed with, and a refusal would crash-loop those services.
- Daemon exit 75 means respawn (Update, Restart). Exit 76 means park (Stop): the parent holds the port with a stub answering `/api/mode` with `stopped: true` and `POST /api/start`.
- **The runtime store installs only the vendor SDKs of the stations in use.** `prepareRuntime` copies the staged sources and runs `bun install` only when the generated `package.json` changed. A station attached later installs its SDK from the daemon side (`stations/runtime-deps.ts`). Both writers produce byte-identical `package.json` files; keep them so.
- **The sync code that runs is the long-lived PARENT's, not the new package's.** A box whose `metro serve` started on an old CLI keeps old sync logic through every update until `systemctl restart metro`. The page's Restart only restarts the child.
- **`metro claude` is a verbatim passthrough.** It prepends the channel flag, `--permission-mode`, `--system-prompt-snapshot off`, `--mcp-config <0600 temp file>` and `--append-system-prompt` (when set), then the user's args unchanged, so a user flag wins.
- When the daemon is serving, it sets `ANTHROPIC_BASE_URL` to the gateway and `ANTHROPIC_CUSTOM_HEADERS=x-metro-key: <key>`. **It never sets `ANTHROPIC_AUTH_TOKEN` while Claude Code has its own login**, because a credential variable replaces the claude.ai login. With no login at all it uses the agent key as a stand-in credential.
- Bypass mode under root sets `IS_SANDBOX=1`, only when uid is 0 and the variable is unset, because Claude Code refuses bypass as root otherwise. `metro claude` also seeds `tengu_harbor` and `tengu_harbor_permissions` into Claude Code's cached flags (`seedChannels`; without the second, Claude Code never sends a permission prompt to the channel, measured on 2.1.281) and marks onboarding done: both are unsupported hacks that a Claude Code release may break.
- `metro tail` prints only event JSON on stdout (status lines go to stderr) because Monitor treats each stdout line as an event.

## The Claude Code plugin (`plugin/`)

- The plugin ships inside the npm package. `stage-runtime.mjs` stamps the staged `plugin.json` with the CLI version, and the daemon installs or updates it at boot (`claude/plugin-install.ts`) from `<store>/marketplace` as a directory marketplace.
- **`plugin/.claude-plugin/plugin.json` `version` must move with any change under `plugin/`.** Claude Code caches by version, so changed code under an unchanged version never reaches a box.
- **The manifest must not name `hooks` or any path that does not exist** (`skills` included). Claude Code loads `hooks/hooks.json` by itself; naming it counts as a duplicate and the plugin fails to load its MCP servers. `test/plugin-manifest.test.ts` pins it.
- `plugin/` is committed plain-Node `.mjs`, no build, no deps. `bin/guard.mjs` is a PreToolUse guard (orchestrator-only main thread; unparsable payload is denied) and applies the owner's tool policy to `mcp__metro__*` calls (`bin/policy.mjs`, see Tool policies). `bin/session-start.mjs` injects the orchestrator rules. `plugin/orchestrator.md` is the one source of those rules.
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
- **`bun run compat` (`scripts/compat.sh`) runs the current page's API calls (`scripts/compat/probe.ts`) against the daemon on the `beta` dist-tag** (`COMPAT_REF` picks another commit): it checks out the commit that set that version into a temp worktree and boots it isolated (`env -i`, temp HOME and dirs, a fake WorkOS issuer, a fake MCP server), and fails on any call the old daemon rejects. The `Compat` workflow runs it on every push and PR, outside the gate. Add a new page call to the probe.
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
- Stations are wired through `stations/registry.ts`; core dispatches over station defs. No per-network branching in core. Capabilities are declared on the `Station` (`hasAccounts`, `hasTrain`, `profileFields`, `readsProfiles`, `resolvesSenders`, `claimsName`, `attachmentMode`, `readFilters`, `approvals`) and read, never branched on by name.
- **A station that keeps secrets of its own on disk declares `forget` and `forgetExcept`** (`core/stations/account-files.ts` `accountFiles(<dir env>, <prefix>)`: `<prefix><account>.json` under the env dir or `~/.metro`). The detach route calls `forget(accountId)` after the account left `agent.json` (a throw is logged, the detach still answers 200), and boot calls `forgetExcept` with every account the agent map still knows, disabled ones included (`forgetOrphans` in `stations/registry.ts`), which cleans files left by a detach before this existed or rewritten by a train that had not stopped yet. Outlook removes `outlook-state-<account>.json` (the refresh token), WhatsApp `whatsapp-tokens-<account>.json`, Threema `threema-groups-<account>.json`. **XMTP's db3 is deliberately left alone**: it holds the inbox installation, and deleting it would spend one of the ten installations if the same key were attached again.
- `hasAccounts` and `hasTrain` are independent. `webhook` is `true`/`false`: no train, accounts read in-core, and `list_members` refuses it.
- A train call line longer than `STDOUT_LINE_MAX` (4 MiB) is dropped by `drainLines`. That is why no base64 ever crosses the train pipe: inline data lands in a temp file first.
- `materializeFrom` prunes stale stubs at first boot too, since the supervisor spawns every `*.ts` in the trains dir. A stub is rewritten only when its content changes.
- A disabled account (`stations[].enabled: false`) stays in the agent map but not in the account file, so its train does not run it. Toggling goes through `syncStations`; an allowlist change only reloads the maps (no train restart).
- **Allowlist entries** (`agents/allowlist.ts`, `senderMatchesAllowlist` and `senderPermitted` in `agents/map.ts`) match the last segment of the sender line, case-insensitive. **An entry starting with `@` is a domain** (`@anderra.ch`): it matches a sender id that is an email address at exactly that domain, never a subdomain (`x@mail.anderra.ch` needs `@mail.anderra.ch`), and never a sender id that is not an address. A bare `@` or a non-domain is refused at save. `*` or an empty list means anyone.
- **A station may report `sender_verified` on an inbound event** (`senderVerified` on the `MetroEvent`, `sender_verified` in the channel meta). When the allowlist is not `*`, a sender whose event says `false` is dropped even if listed; a station that does not report the fact is unchanged. With `*` the event is delivered and the meta says `sender_verified="false"`, which `MCP_INSTRUCTIONS` tells the agent to distrust.

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
- **A station with `approvals: false` (Outlook) never becomes the line a prompt is sent to, and a `yes <id>` from it is an ordinary message**: email is too weak a channel for approvals.
- **A reply counts only on the line the prompt was sent to** (`promptLine` in `approvals/pending.ts`), from a sender the account's allowlist passes (the relay drops everyone else before), and never when the station reports `sender_verified: false`. Only `msg` events are checked, so a webhook body can never answer a prompt. With allowlist `*`, anyone in that chat can answer.
- A `msg` with blank text and no attachment is dropped by the relay.
- `addressed` (`direct`, `mention`, `reply`) is decided in core (`channels/addressed.ts`) from facts stations report (`is_private`, `mentions_self`, `reply_to_self`) plus the relay's memory of ids it sent (`SENT_IDS_MAX` 2000).

### Tool policies and approvals (`policy/`, `mcp/policy-gate.ts`, `plugin/bin/policy.mjs`, `approvals/`)

- **Every metro MCP tool declares `group: 'read' | 'write'` next to its definition** (`ToolDef` in `mcp/tool-def.ts`, `StationTool.group` in core; `destructive: true` for delete, remove and close). Read is `read`, `list_members`, `get_profile`, `list_accounts`, xmtp `group_info`; everything else is write, and an undeclared tool counts as write. `mcp/tool-catalog.ts` is the one list: `toolList()` publishes `readOnlyHint`/`destructiveHint`, `channelToolsOf(station)` feeds the page. `test/tool-groups.test.ts` fails on a tool with no group. **Never mark a metro tool `requiresUserInteraction`**: Claude Code never relays such a tool's prompt.
- **A channel account may carry `policy: {read?, write?, tools?: {<tool>: …}}` in `agent.json`** (`allow`, `ask`, `deny`; absent means allow). The parser is tolerant (a bad value is logged and dropped), the API strict (`normalizePolicy`, 400 by name). The bundle and `.metro` exports carry it. `PUT /api/agents/<id>/accounts/<station>/<account>/policy` (member, like the allowlist) reloads the maps only. `list_accounts` shows each account's effective policy.
- **Both `deny` and `ask` are enforced by the daemon; the plugin hook only raises the prompt.** The daemon (`policyGate` in `runTool`, right after the scope check) refuses a denied call with `Blocked by the owner's policy for <station> (<tool>).` and no train call. **An `ask` call runs only by consuming a grant** (`takeGrant` in `approvals/pending.ts`): answering a prompt `allow` in chat or on the page records `{tool, preview}` for 10 minutes (`GRANT_TTL_MS`, 200 max), and the call whose tool and arguments match it (`previewMatches`) uses it up; anything else gets `NEEDS_APPROVAL` (`approvals/needs.ts`) and no train call. Why: the agent holds its own key, so it could call `/mcp` with `curl` or switch its hook off, and before this the daemon took any `ask` call as approved (2026-09-25, after an agent sent mail with the Outlook token it found on disk). Consequences: an approval given only in Claude Code's terminal dialog does not count (metro never sees it), and a box without the plugin has no way to raise a prompt, so its `ask` calls are refused. `test/policy-matrix.test.ts` is the daemon's case table.
- **The hook reads a snapshot the daemon writes: `<agents dir>/policy.json`** (`mcp/policy-snapshot.ts`, 0600, rewritten at boot and on every `setPolicies`, only when the text changed): `{version: 1, tools: {<tool>: read|write}, owners: {<station tool>: station}, ungated: [...], accounts: {"<station>/<account>": policy}, stations: {<station>: [account ids]}, connectors: {<server key>: {id, name, policy, tools: {<tool>: read|write}}}}`. It lives beside `agent.json` because the hook already knows that folder (`METRO_AGENTS_DIR`, else `~/.metro/agents`, the same rule as `bin/metro-plugin.mjs`), Claude Code runs as the daemon's user, and the folder survives a plugin update, which wipes the plugin's own directory. **The hook mirrors `channelTargets`/`decide` exactly** (a `line` with an `account` override, `get_profile`'s `from`, `station` for `create_group`/`set_profile`, a station tool's owner, an account alone, else every account of the station with the strictest winning; per-tool beats group; unknown tool is write; nothing set is allow); `test/policy-snapshot.test.ts` runs the real `guard.mjs` on the daemon's own snapshot and compares it with `channelDecision`. **A missing or unreadable snapshot allows**: the daemon still refuses blocked calls.
- **What the hook answers**: `deny` on either thread is a deny with the same sentence as the daemon. `ask` inside a subagent (the payload carries `agent_id`) is `permissionDecision: 'ask'`, which forces Claude Code's prompt even in bypass mode; only that subagent waits, the main thread keeps answering, and several prompts relay in parallel. **`ask` on the main thread is a deny telling the orchestrator to run that exact call from a background worker**, because a prompt there blocks the whole session (no timeout: an unanswered prompt waits forever). Never answer `defer`: Claude Code ignores it in interactive mode and the tool just runs. `test/plugin-guard.test.ts` pins every case.
- **The prompt reaches the owner through the channel permission relay** (`mcp/permission-relay.ts`): Claude Code sends `notifications/claude/channel/permission_request` `{request_id, tool_name, description (the tool's own), input_preview (JSON of the input)}`, metro posts it to the session's known line (the chat the request came from; never an `approvals: false` station, never a line outside scope), formatted by `mcp/permission-prompt.ts` (`Approval needed: <tool>`, the channel, the text, then `Reply "yes <id>" or "no <id>"`), and answers with `notifications/claude/channel/permission` `{request_id, behavior}`. **The prompt goes to the session's last inbound line (`knownLine`), not to the chat the call targets**, so with several chats an allowlisted sender in another chat can answer it (the owner's choice). **Claude Code elides a long string in `input_preview`** (2.1.281: the first 1999 characters, `\n⋯ <N> code points elided ⋯\n`, the last 1499, and possibly a trailing `⋯ … field(s) elided … ⋯` block), so the preview is not JSON: `approvals/preview.ts` `readPreview` turns each marker into a placeholder before parsing and cuts a field-elision block, the chat shows `…` there, and `previewMatches` (what `settlePromptsFor` uses) takes an elided string as a head and a tail of the real value. **A chat prompt is at most 1,000 characters and never carries a metro or connector tool's `description`** (a 4,470-character prompt was refused by Telegram, whose cap is 4,096, and a refused relay send is only logged). A prompt answered on the page or expired also posts `Approved on the page.`, `Denied on the page.` or `Expired, denied.` on its chat line.
- **metro keeps the pending prompts** (`approvals/pending.ts`, in memory, 500 max, dropped with the session that raised them, since a Claude Code restart drops its prompts too): a chat answer (see Human in the loop), the page (`GET /api/approvals` lists `{id, tool, description, preview, line, requestedAt}`, `POST /api/approvals/<id> {decision: allow|deny}`, member-level, 404 for an unknown or already answered id) or the expiry (`METRO_APPROVAL_TTL_H`, default 24, swept every minute, answers `deny`) settles one. **A terminal answer is not observable**: a prompt whose call then reaches the daemon with the same arguments is dropped (`settlePromptsFor`), a denied one stays until expiry, and a late answer to a prompt Claude Code already closed is harmless. `test/permission-relay.test.ts` drives the relay, the chat answer, the page and the expiry over real HTTP.
- **Connectors carry the same policy** (`connectors/gates.ts`, `connectors/relay-policy.ts`): `config.policy` on the row in `connectors.json` (tolerant parse in `readConfig`, so the bundle and `.metro` exports carry it with the rest of `config`), set by `PUT /api/connectors/<id>/policy {policy}` (member, like every connector write; the payload carries `policy`), registered with `setPolicies('connector', …)` on every `connectors.json` write and at boot. **The groups come from the vendor's own `readOnlyHint`: read-only is `read`, everything else `write`, and a tool metro never saw listed is `write`** (fail safe). The daemon keeps the last seen listing as `config.toolGroups` (`{<tool>: read|write}`), refreshed with `listRemoteTools` whenever the page lists the tools, on a policy save, and at boot for every connector with a policy; a failed listing keeps the old groups. The relay does NOT read `tools/list` answers passing through (streaming stays untouched). `RemoteTool.name` is the real tool name (policies key on it) and `title` the display name.
- **Claude Code names a plugin server's tools `mcp__plugin_metro_<server key>__<tool>`**: the server is `plugin:<plugin>:<key>` and the tool prefix is `mcp__` plus the server name with every character outside `[a-zA-Z0-9_-]` turned into `_` (read out of the 2.1.281 binary, `function wn` and `mcp__${wn(e)}__`). The server key is exactly `serverKeysOf` in `plugin-sync.ts` (one function for `.mcp.json` and the snapshot). The hook (`connectorVerdict` in `plugin/bin/policy.mjs`) and the daemon (`connectorToolOf`) also accept `mcp__<server key>__…` and `mcp__metro_box_<name>__…` for a server added by hand. The main thread never reaches a connector's policy (the orchestrator guard already denies every connector call there); in a subagent `deny` is a deny and `ask` is Claude Code's prompt, relayed like a channel tool's (`permission-prompt.ts` writes `Approval needed: <tool>`, `Connector: <name>`, then up to eight arguments).
- **The relay is the daemon's hard stop for connectors**: a POSTed JSON-RPC `tools/call` (a single message or inside a batch) whose tool is denied is answered by metro with `{result: {isError: true, content: [{type: 'text', text: "Blocked by the owner's policy for <connector> (<tool>)."}]}}` and the same id, and never reaches the vendor. A batch mixing blocked and allowed calls forwards the rest and merges metro's answers into the vendor's reply (a JSON array, or extra SSE frames), which buffers that one reply; everything else passes byte for byte. An `ask` call is answered the same way with `NEEDS_APPROVAL` unless it consumes a grant whose prompt names the same connector and tool (`blockedReason` in `connectors/gates.ts`, the arguments from `params.arguments`). `test/relay-policy.test.ts`, `test/connector-policy.test.ts`.
- **`MCP_INSTRUCTIONS` (`mcp/instructions.ts`) must stay under 2,048 characters**: Claude Code keeps only the first 2,048 (2.1.281 logs `Server instructions truncated from 2140 to 2048 chars`), which cut the approval rule at its end. `test/permission-relay.test.ts` pins the length; tighten wording rather than drop a rule.
- metro's own approval flow (stored calls, `approvals.json`, "Waiting for the owner's approval", the `approval_id` channel message) lived for an afternoon on 2026-09-24 and was replaced by the native prompt at Less's call; do not bring it back.

### Attachments and uploads

- **Inbound:** a station emits `attachmentSaved` or `attachmentFailed` (with `reason`), both through one correlator (`InboundRelay.mediaCtxFor`). A failure note has no url and no path.
- `saveStreamToCache` streams to `.part` with a running size check and renames on success.
- **The inbound cache (`attachDir()`) cleans itself** (`files/attach-reaper.ts`, started from boot beside the upload reaper: one sweep at start, then every 10 min, never fatal, logs counts at info). A file older than `METRO_ATTACH_TTL_DAYS` (default 7, by mtime) goes with its `.owner`/`.grant`; an orphan sidecar goes; a `.part` older than an hour goes (its sidecars are kept while a fresh `.part` exists); then the dir is capped at `METRO_ATTACH_MAX_MB` (default 2048), oldest first. A zero or bad value means the default, never "delete everything". **Only cache-shaped names are touched** (`resolveCachedAttachment`, the rule `/attach` serves by), so anything else in that dir is safe. The TTL is generous because a url handed to an agent may be fetched days later.
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
- `METRO_OWNER` (`--owner`) is written to `.owner` only when no organization owns the box yet, so a unit's old value never undoes a move (`boot/local-owner.ts`). A `.owner` still holding a wallet address reads as no owner.
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
- **Outlook** (`packages/outlook`, Microsoft Graph): attach is interactive and **signs in through the browser by default**: the OAuth 2.0 authorization code flow with PKCE (S256), public client, on the `/common` authority (`browser.ts`, `OutlookBrowserLogin` in `login.ts`, driven by `stations/attach-outlook.ts` step `browser`). `start` answers `authorizeUrl` (state and verifier held by the attach session, 15 min); the page opens it in a new tab and remembers `{state, box, agent, attach session}` in `metro.outlook.pending`; Microsoft redirects to **`https://metro.box/?code=…&state=…`** (registered under the "Mobile and desktop applications" platform of the app, so the daemon may redeem the code without an Origin; `METRO_OUTLOOK_REDIRECT` overrides it, e.g. `http://localhost:5173/`), and any page load with that query is handled before routing (`api/outlook-return.ts`, `OutlookReturn.tsx`): it posts `step {code, state}` (or `{state, error, errorDescription}`) to that box's attach session, which checks the state, redeems the code, checks the mailbox with `GET /me` and stores it; the original tab keeps polling and flips on its own. **Why not the device code flow**: the first real sign-in (Anderra, 2026-09-24) failed with AADSTS530035, the tenant's security defaults block device code as a phishing risk. **The device code stays as the fallback** ("Use a code instead", `step {mode: 'device'}`): the page shows the code and a link to microsoft.com/devicelogin and the driver polls. A daemon on beta.175 answers `start` with step `device` directly, which the page still renders. Microsoft refusals become sentences (`failureOf`): consent (AADSTS65001, 90094, 90095) names the `/organizations/adminconsent` link, a policy block (530035, 53003) says the company blocks that sign-in. **The client id is Metro's own multi-tenant public app "Metro Mail"** (`OUTLOOK_CLIENT_ID`, in Stage Labs' tenant "Default Directory", publisher not verified yet, so a company tenant may need its admin to approve it once); `METRO_OUTLOOK_CLIENT_ID` overrides, and an empty id refuses with "Outlook is not set up on this Metro yet". A mailbox is attached once per box (409). The train keeps the rotating refresh token, the delta link and the ids it delivered in its own 0600 file (`~/.metro/outlook-state-<account>.json`, `OUTLOOK_STATE_DIR`), since trains never write `agent.json`; refresh is single-flight. It polls **the Inbox only** (Junk is never read) with Graph delta every 30 s (`METRO_OUTLOOK_POLL_MS`); the first sync records the delta link and emits nothing. Lines are `metro://outlook/<account>/<conversationId>` (`/`, `+`, `%` escaped), senders `…/user/<address>`. **Automated mail is skipped by default** (a no-reply style sender, `List-Unsubscribe`, `Auto-Submitted` other than `no`, `Precedence: bulk|list|junk`; `includeAutomated: true` in the account config keeps it). **Each delivered mail carries `sender_verified`**: true only when Microsoft's topmost `Authentication-Results` (or its own `ARC-Authentication-Results`) shows `dmarc=pass`, or `compauth=pass`, for the From domain, or the mail is internal (`X-MS-Exchange-Organization-AuthAs: Internal`); `trust.ts` decides. Verbs: **`send` on an address line (`metro://outlook/<account>/<email address>`, any resource holding `@`, which a conversation id never does) starts a new email**: a draft with `subject` (the `send` tool's optional argument, forwarded by the daemon; else the text's first line, 255 chars) and a Text body, files attached, then `/send`; the answer carries the new thread's `line`, which the daemon appends to the tool result, and a `reply` or `reply_to` on an address line is refused. `send` on a conversation line is reply-all to the conversation's latest mail, `reply` answers the named message, both through `/reply`/`/replyAll`, or a draft plus attachments plus `/send` when files go along; files are inline Graph attachments **up to 3 MB each**, refused above that before any draft exists. `read` implements every filter: `query` is Graph `$search` (with `from` folded in; the rest narrow what it found, since Graph refuses `$search` with `$filter`), otherwise one `$filter` newest first; `message_id` returns the full mail, saves its files and marks it read (nothing else marks mail read). **The connect form takes an optional mailbox** (`mailbox`): it rides as `login_hint` (with `prompt=select_account` kept), and after the code (or device code) is redeemed, a `GET /me` whose `mail` and `userPrincipalName` both differ from it fails the attach with "You signed in as X, not Y. Nothing was connected." and stores nothing (`verifyMailbox` in `me.ts`). Why: the first live connect at Anderra (2026-09-24) picked the admin already signed in to Microsoft in that browser, so Andy's agent got Fabien's mail. A daemon before this change ignores the field.
- **Outlook sign-in setup trap (2026-09-24, first live connect of andy@anderra.ch):** the Metro Mail app's `https://metro.box/` redirect must exist ONLY under `publicClient.redirectUris` in the Entra manifest. The new Entra UI filed it under Web, and even after `web.redirectUris` was emptied, a leftover entry in `web.redirectUriSettings` kept Microsoft treating the code redemption as a confidential client (AADSTS7000218, `client_secret` required). Emptying `redirectUriSettings` fixed it. Admin consent for Anderra was granted by an admin account at the first sign-in.
- **Webhook:** the url names `webhookId` (random digits), never `account_id`, which would leak the agent id. The whole url is the credential; anything else is a flat 404. The route must stay before the monitor router. **Attaching a webhook is refused on a local daemon today** (400, it needs a public url), so the code path is dormant.
- **`read` is the one verb for history and lookups** (`mcp/read-tool.ts`): `line?`, `account?`, `limit?`, `before?`, `since?`, plus `until?`, `query?`, `from?`, `unread_only?` and `message_id?` (one message in full; its files come back with a `local_path` and a `/attach` grant url, like inbound media). The daemon forwards every argument unchanged (camelCase on the wire) and adds `ignored: [...]` for each filter the station does not declare in `readFilters`, so existing stations behave as before. A read with no line needs an `account`, is scoped like any account call (`scopeDenied`), and is refused unless the station declares `account` in `readFilters`.
- **The daemon checks a call's verb against the station's `messageVerbs`**: `dispatchMessageTool` refuses an undeclared verb before any train call, naming the verbs the station supports (`test/message-verb-gate.test.ts`). Trains do not refuse verbs themselves. A train action that no declared verb, group op, tool, profile or account route names is dead code: delete it.
- Discord-bot verbs: all seven and group ops. Voice was removed. An inbound Discord edit reaches `metro tail` only; the channel relay routes `msg`, `react` and `system`.
- XMTP has no push: no FCM, no `METRO_CTRL:` control DMs. Every inbound DM goes through the allowlist. Its own tools are the Stage ones (`close_channel` with `removeInboxIds`/`removeSelf`, `set_channel_metadata`, labels); there is no `create_channel`, an agent uses `create_group` then `set_channel_metadata`.
- **A train builds its events with `@metro-labs/core/stations/train-events`** (`emitInbound`, `reportAttachment`, `attachmentSavedEvent`, `attachmentFailedEvent`, `selfUri`). Never hand-build an `attachmentSaved` envelope; it carries both `attachmentPath` and `localPath` because the daemon reads `attachmentPath ?? localPath`. The boot banner and empty-accounts exit are `announceAccounts` (`core/stations/train-boot`); a client-per-account train (telegram, whatsapp) is one `runClientTrain` call. Account configs carry no `owner`.
- **Receiving is never held for a profile lookup**; anything costing a network call is behind the `get_profile` tool.

### Claude Code on the box

- `claude/files.ts` reads Claude Code's own files under `METRO_CLAUDE_DIR`, `CLAUDE_CONFIG_DIR` or `~/.claude`. Names are validated with regexes before a path is built; the URL is split before decoding.
- **Memory files may sit in folders** (`claude/files.ts`): the listing walks `memory/` up to 5 folders deep (5,000 files max) and names each file by its path (`entities/people/less.md`); only the root `MEMORY.md` is left out as the index. Every folder segment must match `FOLDER_RE` (no leading dot, so `..` and hidden folders are refused) and the file `MEMORY_RE`; the page sends the path percent-encoded as one URL segment, and the daemon decodes it after splitting. A daemon before this change lists only the top level and refuses a nested name on import.
- **Settings and skills are resolved by id through their own listing, never by building a path.** Writes go through `writeAtomic` (`core/secure-fs`: temp file then rename, keeps the file's mode, 0644 for a new one, or the mode passed in; never `writeSecure`, which would force 0600), refuse non-object JSON (400) and a stale `seenAt` (409). Skills list `~/.claude/skills` only; a symlinked skill folder counts, and deleting it removes the link only.
- **Setup applied at boot** (`claude/setup.ts`): the worker agent and orchestrator skill are written when missing, and refreshed only when their sha256 is one metro shipped.
- **Whenever `WORKER_AGENT` or `plugin/orchestrator.md` changes, add the previous text's sha256 to `PRIOR_WORKER` or `PRIOR_SKILL`**, or boxes keep the old copy. Privacy env is merged into `~/.claude/settings.json` (Claude Code's auto-updater is off as a result; the Harness page's Update runs `claude install latest`).
- **The session watcher** (`claude/session.ts`) keeps tmux session `metro` running `metro claude` (`-c` when a conversation exists), and restarts it after a metro update or a mode or system-prompt change, since flags load at session start.
- The Claude login drives `claude auth login --claudeai` in a pty. **metro never re-implements claude.ai OAuth and never reads the credential.**

### The Claude session's memory (`claude/memory.ts`)

- **Why:** Tony (8 GB) ran out of memory twice on 2026-09-25 under ~16 Node builds and 30 to 48 headless Chromes started by its workers; the kernel killed one Chrome, and because the whole session lived in `metro.service` with systemd's default `OOMPolicy=stop`, systemd stopped the daemon, every train and the session each time.
- **The unit keeps running when one process is killed**: `metro service install` writes `OOMPolicy=continue`, and the daemon writes the same into `/etc/systemd/system/metro.service.d/10-metro-memory.conf` plus `systemctl daemon-reload` at boot (`ensureServiceOomPolicy`, only as root under systemd with `INVOCATION_ID` set and the unit present), so existing boxes get it without a reinstall; it takes effect at the next service restart.
- **The Claude session's tmux starts in its own systemd scope** (`inSessionScope`: `systemd-run --scope --collect --unit=metro-claude-<ms> -p MemoryMax=<limit> -p MemoryHigh=<90%> -p OOMPolicy=continue -- <cmd>`, Linux, root and systemd only), used by the session watcher and the Terminal whenever the tmux server is not already up (`tmuxServerUp`), so every tmux session of that user lands in it. The limit is 80% of the box's memory, always leaving 1.5 GiB, never under 1 GiB (`sessionMemoryLimit`). A memory kill then stays inside the scope and takes the heaviest process only. Consequences: a daemon restart or `systemctl stop metro` no longer kills the session (the update restart in the watcher still replaces it), and on a box whose tmux server was started inside the unit, the first restart after this ships moves it, since the old server dies with the unit.

### Claude Code as its own user (`agent-user/`, always on Linux as root)

- **Why:** on the boxes the daemon and Claude Code both ran as root, so the agent could read every channel credential; on 2026-09-25 an agent sent mail with the Outlook refresh token it found in `~/.metro`. It was switchable for one day (the switch, the move of root's work, the copy-back when switched off, `api.ts`, `workspace.ts`, `git-links.ts`, `AgentUserSwitch.tsx`, `MoveWork.tsx`); every box switched and moved its files, then it became permanent (Less, 2026-09-25) and all of that went. **A Linux daemon running as root always runs Claude Code as the user `agent`** (`agentUserExpected`); anywhere else (macOS, a non-root daemon, the tests) nothing changes. If the user cannot be prepared, the Claude session stays stopped with a reason (`sessionBlocked`); it never falls back to root. The daemon itself stays root.
- **Boot** (`provision.ts`, before the plugin install and the session watcher): `useradd --create-home agent` when missing, home 700; installs Claude Code for the agent with the official installer when `~/.local/bin/claude` is missing; copies the store's plugin marketplace to `<home>/.metro/marketplace` when its version moved (the store under `/root` is unreadable to the agent, so `stagedMarketplaceDir` answers that copy); starts the view sync.
- **Every `claude` and `tmux` call runs as the agent** through `asAgent` (`setpriv --reuid=<uid> --regid=<gid> --init-groups env -i HOME=… PATH=<home>/.local/bin:… <cmd>`; **never `runuser`**, which stays as a parent process and does not pass SIGWINCH on, so the Terminal's `tmux` never learned the browser's size): the session watcher, plugin install, version and update, the login pty, `auth status`, and the Terminal tab, which therefore opens the agent's tmux, never a root shell. `claudeDir()`, `claudeConfigPath()` and the session's home follow the agent's home. The session command is `env METRO_AGENTS_DIR=<home>/.metro/agents METRO_WEBHOOK_PORT=<port> node <cli> claude` (bun lives under `/root`).
- **Every write the daemon makes into the agent's home runs AS the agent** (`home-fs.ts`: `writeHomeText`, `writeHomeInPlace`, `removeHome`, `moveHome`, `receiveHomeFile`, `copyIntoHome`, small `sh` scripts over `setpriv`, the content on stdin): root writing into a folder the agent owns would follow a symlink the agent planted (`skills/evil -> /etc`). Memory, sessions, settings, skills, the setup files, onboarding, `.mcp.json` and transcript uploads all go through it; with no agent user they are plain fs calls.
- **The agent reads a key-free copy of the Metro files** (`view.ts`, `<home>/.metro/agents`, 0600, owned by the agent, refreshed every 5 s): `agent.json` as `{version, id, key}` only, `model.json` as `{route, connections: [{id, provider, model}]}` with no provider key, and `policy.json`, `claude-setup.json`, `system-prompt.md` as they are. The agent may edit its copies; nothing trusts them (the daemon enforces policy and approvals itself).
- **An inbound file reaches the agent as its url only**: the cache is root's, so the note drops the daemon path and `local_path` (`buildMediaNote(…, showPath)`, `surfaceMedia`, `withUrls` in `read-tool.ts`). The plugin's `.mcp.json` goes into the agent's marketplace copy (`stagedPluginDir`).
- **A `send` attachment by `path` is read as the agent** (`fromPathAs` in `stations/attach-resolve.ts`: `cat` over `setpriv` into a temp file), so the daemon never sends a file the agent could not read itself.
- **Scheduled jobs always run as the agent** (`schedules.ts`, `schedules-api.ts`: `GET /api/schedules`, `POST /api/schedules {id}` to retry one, admin; `ScheduledJobs.tsx`, its own page `#/<agent>/scheduled` with a Scheduled row under Runtime after Harness, gated on `SCHEDULES_SINCE` beta.192). At every boot, after provisioning, `convertRootJobs` switches every job that still runs as root AND names `/root` in its command, environment or working directory (`usesRootHome`, a path boundary, so `/rooted` or `/srv/root` never match; those jobs are the agent's, since `/root` was its home): a systemd timer (unit file in `/etc/systemd/system`, metro's own units excluded) gets `<service>.d/10-metro-agent.conf` (`User`, `Group`, `WorkingDirectory`, `HOME`, `PATH`, the other environment and `ExecStart` rewritten with `rehome`) and `daemon-reload`, refused when a rewritten path under the agent's home does not exist; a root cron line moves to the agent's crontab rewritten, with root's crontab backed up in `<agents dir>/crontab-root.<stamp>.bak`. A job that cannot be switched keeps its reason in memory (`problem`) and shows it with Retry. **Each job has its own page** `#/<agent>/scheduled/<id>` (`ScheduledJobPage.tsx`; `schedule-detail.ts`: `GET /api/schedules?id=` answers the job plus `definition` (`systemctl cat` of the timer and its service, or the cron line) and `logs` (the service's last 80 journal lines, or the last 80 lines of the file the cron command redirects to, `logFileOf`), `POST {id, action: 'run'}` is Run now: `systemctl start --no-block` for a timer, the command detached as the agent for a cron line, refused for a job still running as root). The page lists the agent's jobs and those stuck root ones; root's other jobs (the system's) never show, and there is no way back to root (Less, 2026-09-25: "it should always run as agent"). Most boxes had a nightly memory job as a root timer or cron line calling a script under `/root`.
- **What the migration taught, for anyone moving a box's files again by hand** (2026-09-25): copying Tony's 43 GB `work` filled the disk to 97%, a same-disk `mv` is instant; git worktrees keep absolute `gitdir: /root/...` paths and must be rewritten (both the worktree's `.git` file and `.git/worktrees/*/gitdir` in the main repo); tools and model caches in root's hidden folders (Lisa's faster-whisper models in `~/.cache/huggingface/hub`) do not follow a move of visible folders; root timers and cron jobs keep pointing into `/root`.
- `bun run agent-user-check` (`scripts/agent-user/`, needs Docker) runs the real thing in a Linux container as root: user creation, the install, the plugin and view copies, the refusals (root's files, a planted symlink, a root-only attachment), the session in the agent's tmux, `setpriv` with no parent left, and a root cron line switched to the agent. It is outside the gate.

### The model gateway (`apps/daemon/src/gateway/`)

- Claude Code on the box talks to `/gateway`; auth is the agent key in `x-metro-key`, never `Authorization` (that holds Claude Code's own login).
- **A model change restarts the Claude session** (`kept` in `gateway/model-api.ts`, when `routeOf` moved; `ModelApiDeps.restartSession` for tests): `metro claude` starts Claude Code with `ANTHROPIC_MODEL=<provider>:<model>`, and an id carrying a provider goes to that provider on every request, so a running session kept the old route whatever the page said (Alice, 2026-09-25: switched to Codex, still answered by OpenRouter's 402). The watcher brings the session back with `-c`.
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
| `GET /api/agents`, `/api/agents/<id>/accounts…` | bearer | The one agent as `{id, name, connector_ids}` (no key, no delete), `tools` per station, account attach, allowlist, policy, enable, senders, resolve, XMTP name. |
| `GET /api/approvals`, `POST /api/approvals/<id>` | bearer | Pending Claude Code permission prompts; `{decision: allow\|deny}` answers one over MCP. |
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
- **The page ships before the boxes update, so it must keep talking to older daemons.** Before removing a parameter or field a daemon reads, check which daemon version stops needing it and keep sending it until every box is past that version (dropping `?project=` too early answered "a project is required" on every box, 2026-09-23; it went for good once every box ran beta.189).
- **Not an MCP client.** `apps/ui/src/mcp/client.ts` must not come back.
- A feature that needs a newer daemon is gated with `olderThan(version, X_SINCE)` and shows "Update first"; an unknown version never hides a feature. The gate left is `SCHEDULES_SINCE` (beta.192, the Scheduled page); every box ran beta.189 or later when the older ones went (2026-09-25). Do not add a gate for a version below what the page can talk to at all.
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
- The launch allowlist (`METRO_LAUNCH_OWNERS`) and per-identity launch cap; the WorkOS provider probe and `GET /api/auth` (a provider not set up in WorkOS shows WorkOS's own error).
- The old `agents/<name>/agent.json` layout in the CLI and the plugin helper (the daemon's `migrateAgentLayout` still moves it at boot) and the `[agent]` argument of `whoami`.
- A plaintext credential table on metro.box.

## Working discipline

- **Verify, then act.** Confirm claims against the code before changing or asserting them. Many "obvious" facts here have load-bearing exceptions; `docs/HISTORY.md` holds the reasons.
- Do not call code dead without an `rg` proving zero references, including exports maps and the station registry.
- Branch off `main`, open a PR, land via PR. Run `bun run smoke` after a layout change.
