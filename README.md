# Metro

Metro lets a Claude Code agent hold real conversations on chat networks while it works.
It is a daemon that runs **on your own machine** (`metro serve`). It bridges these chat
networks to Claude Code through MCP (the Model Context Protocol):

- **xmtp**: end-to-end encrypted DMs and groups on the XMTP network.
- **telegram-bot**: a Telegram bot, through the Bot API.
- **telegram**: a real Telegram **user account**, over MTProto.
- **discord-bot**: a Discord bot.
- **whatsapp**: a real WhatsApp **user account**, through the multi-device Web protocol.
- **threema**: a Threema Gateway ID in end-to-end mode. Messages cost Gateway credits.
- **outlook**: a Microsoft 365 or Outlook.com mailbox, connected with a Microsoft sign-in code.
- **gmail**: a Gmail or Google Workspace mailbox, connected with your own Google OAuth client
  ([docs/GMAIL.md](docs/GMAIL.md)).
- **webhook**: an inbound-only HTTP receiver. The code is there, but the page does not
  offer it yet.

Inbound messages reach the Claude Code session as channel events. The agent answers with
the `mcp__metro__*` tools: `send`, `reply`, `react`, `unreact`, `edit`, `delete`, `read`,
`list_members`, `create_group`, `add_members`, `remove_members`, `export_invite`,
`create_upload`, `list_accounts`, `list_channels`, `set_profile` and `get_profile`. Support for each verb
depends on the network; an unsupported verb answers with the reason.

> `telegram` and `whatsapp` sign in as real user accounts. Their stored sessions are
> full-account secrets, both networks may ban an account used this way, and only one
> process may use an account at a time. Use an identity you can dedicate to the agent.

## Find a channel

Use `list_accounts` to choose an account, then call `list_channels` with that account.
It discovers existing conversations without requiring a recent inbound message. The optional
`query` is a case-insensitive substring of a name, ID or line (up to 200 characters).
`limit` defaults to 50 and accepts 1–100. Each entry has an ID, kind, an account-qualified
`metro://` line usable by other tools, and a name when the station knows one.

Follow `next_cursor` with the same account and query to continue. Cursors expire after five
minutes and can also expire after enough other listings or a train restart. Start without a
cursor to refresh. A page can be empty and still have a cursor, especially when searching
mail: continue until the cursor ends. Directory scans stop at 5,000 source entries and retain
bounded metadata rather than building an unbounded account index.

Always check `capability`: `supported` says whether discovery exists, `source` identifies
remote, local or mixed metadata, and `complete` is false while more pages or coverage gaps
remain. `reason` explains the limitation. Exhausting a local cache does not make it complete.
Telegram user accounts can enumerate dialogs; other stations may have installation-local
conversations, observed bot chats, cached direct chats, missing archived threads or mailbox
scope limits. Webhooks explicitly report discovery as unsupported. Station READMEs describe
the exact coverage.

Results contain channel metadata only, not message bodies, snippets, attachments or contacts.
Discovery never creates a conversation. Account access and the owner's read deny/approval
policy apply before listing; Receive Off only suppresses inbound delivery and does not block
an otherwise permitted explicit lookup.

## The pieces

- **The daemon** (`apps/daemon`) runs on your box. It holds the agent, its channels and
  its connectors as files under `~/.metro/agents`. It serves MCP, the APIs the page uses,
  and a model gateway, and it runs one subprocess ("train") per chat network.
- **The app** (`apps/app`) manages your boxes: https://metro.box on the web, and the
  same code on Android and iOS. It talks to each daemon directly, over the daemon's own
  public address.
- **api.metro.box** (`apps/api`) runs no chat network and sees no message. It holds
  sign-in (through WorkOS: Google, Microsoft or GitHub), organizations, the list of
  agents, and the launcher that can start a box on AWS. It is the only place with a
  database (Postgres).

A box is one agent. It belongs to one WorkOS organization, and only members of that
organization can sign in to it.

## Install and run

You need Node 22 or newer, [Bun](https://bun.sh) on PATH, and
[Tailscale](https://tailscale.com) installed and signed in. Metro always publishes the
daemon through Tailscale Funnel, so enable Funnel once on your tailnet when Tailscale asks.

```sh
npm i -g @stage-labs/metro@beta     # the beta tag matters: `latest` is an old version
metro serve --owner <organization id>
```

`--owner` takes the id of your organization on metro.box (`org_…`). It is needed on the
first start only; the daemon remembers it in `~/.metro/agents/.owner`.

On start the daemon:

- creates the box's agent if there is none yet,
- names the machine `metro-xxxxxx` on your tailnet and publishes it at
  `https://metro-xxxxxx.<tailnet>.ts.net`, an address that survives restarts,
- installs the SDKs of the channels the agent uses into `~/.metro/runtime`,
- installs the metro Claude Code plugin, if `claude` is on the machine,
- prints the link to open it on metro.box.

To keep it running across reboots and crashes, install it as a service (systemd on Linux,
launchd on macOS):

```sh
metro service install --owner <organization id>
```

Then the page can stop, start, restart and update the daemon without a shell. A box
launched from metro.box (see [docs/ISSUING-SERVERS.md](docs/ISSUING-SERVERS.md)) does
all of this on its own.

## Claude Code on the box

```sh
metro claude [args...]
```

`metro claude` starts Claude Code with the metro channel and the metro MCP server
already loaded, using the agent's key. Nothing needs `claude mcp add`. Every argument is
passed to `claude` as it is. It also routes inference through the daemon's model gateway,
so the **Model** page decides where requests go: Anthropic, Amazon Bedrock, OpenRouter,
Codex (a ChatGPT plan, through OpenAI's Sign in with ChatGPT or the Codex app's code
sign-in) or Gemini.

You rarely type it yourself. Once the box has an agent and a model it can use, the daemon
starts the session in a tmux session named `metro`, answers Claude Code's first-run
prompts, and restarts it when it exits, continuing the last conversation. The Terminal tab
on the page opens that tmux session.

The session follows [docs/SETUP.md](docs/SETUP.md): an orchestrator-only main thread, a
`worker` subagent, standing rules as a skill, and privacy settings. The plugin and the
daemon apply all of it.

## CLI commands

| Command | What it does |
| --- | --- |
| `metro serve [--port <n>] [--owner <organization id>]` | Run the daemon in the foreground. |
| `metro service install [--port <n>] [--owner <organization id>]` | Run `metro serve` as a service. `metro service uninstall` and `metro service status` too. |
| `metro stop` | Stop metro on this machine. |
| `metro tail [agent-id]` | Follow this machine's inbound events, one JSON line each. |
| `metro whoami` | Print the agent this machine runs. |
| `metro claude [args...]` | Open Claude Code with the metro channel, the metro MCP server and the model gateway. |
| `metro update` | Update to the newest published version. `--check` only reports. |
| `metro version` | Print the CLI's version. |

Environment: `METRO_WEBHOOK_PORT` (the daemon's port, default 8420), `METRO_AGENTS_DIR`
(default `~/.metro/agents`), `METRO_AGENT_KEY` (the key `metro tail` presents), and
`METRO_RUNTIME_DIR` (run the daemon from another directory).

The CLI only ever talks to the daemon on the same machine. There is no sign-in on the
command line.

## Connectors

A connector is a remote MCP server (Linear, Microsoft 365, and so on) that the agent can
use. Add it on the page's **Connectors** tab. The daemon checks that it answers, keeps its
credential (a header or OAuth tokens), and relays the traffic at
`http://127.0.0.1:8420/relay/<id>`, adding the credential on each request. Each connector
shows up in Claude Code as its own MCP server through the metro plugin; a running session
picks up a change with `/reload-plugins --force`. No connector credential reaches Claude
Code's config, the browser or metro.box. For Microsoft 365, see
[docs/MICROSOFT-365.md](docs/MICROSOFT-365.md).

## GitHub skills

With the **Agent SDK** runner selected, a box administrator can connect one private
GitHub repository on **Skills**. Enter `owner/repository`, a branch, tag or full commit
SHA, and the folder containing the skills. Use a fine-grained token restricted to that
repository with **Contents: read-only** and an expiry. The organization may need to
approve it. Metro cannot enforce how broadly a token was issued; restrict it at GitHub.
The daemon keeps it in its private `github-skills.json`, never in the agent's files,
API responses or `.metro` exports. Removing the source forgets it, but does not revoke it
at GitHub.

Each skill has `skill-name/SKILL.md`, with YAML `name` matching the folder and a
`description`. Optional metadata is limited to `argument-hint`, `disable-model-invocation`
and `user-invocable`. Supporting files are allowed. Symlinks, submodules, hidden files,
active metadata such as hooks or tool grants, and shell substitutions are refused.
Limits are 64 skills, 256 files, 256 KiB per file, 8 MiB total and 128 KiB of manifest
metadata. Git executable files keep owner execute permission; sync never runs them.

Metro reads GitHub's tree and blob APIs at an immutable commit. It does not clone,
extract an archive or run repository scripts. It checks about once a minute, with
backoff on failure; while an update waits to load, automatic checks wait too. Downloads
are staged separately. The running SDK switches generations and reloads skills only
between safe turns, after calls, tools and workers finish. Chat, shared voice and SDK
scheduled work use the same gate. Fetch or validation failures keep the last loaded
revision; reload failures restore it, or pause input if recovery cannot be confirmed.
The page distinguishes staged and last-loaded commits.

Local skills remain editable and take priority over matching repository names. If a
local alias cannot be read safely, remote skills are hidden until it is fixed; removal
still works. Managed rows are read-only in Metro. Removing the source unloads only managed skills at a safe
turn; old managed generations are cleaned after a short retention window at an idle
point. It cannot erase instructions already read into a conversation. The files belong
to the agent's OS user, so they are not an OS sandbox or tamper-proof storage.
Repository writers control agent instructions, and an agent can run supporting scripts
later under its normal permissions. Connect only a trusted repository.

The Claude Code runner and separate CLI jobs do not load this source. An older or
stopped Agent SDK runner must be started on a version supporting the feature. Sync
never changes plugin enablement or connector configuration.

## Export and import

The agent's Settings page can **Export** the agent to a `.metro` file on your disk, sealed
with a passphrase you choose. You pick what goes in: channels, connectors, skills, memory,
sessions and the model setup. **Import** on another box opens the file with the same
passphrase and adds what is missing, or overwrites what matches. Nothing goes through
metro.box.

## Monitor transport

The **Channel** above is the primary transport. The **Monitor** is a second, live-only
transport on the same port for tools that only want to watch Metro over plain HTTP: `GET
/api/tail` is an SSE stream of live bus events from the moment of connection (25s keepalive,
no replay), with the same credential and the same scope as `/mcp`. `metro tail` uses it.
While the daemon holds no agent key at all, the whole `/api/*` surface stays disabled (404).
Sending goes through MCP only.

```sh
curl -N -H "Authorization: Bearer $METRO_AGENT_KEY" http://127.0.0.1:8420/api/tail
```

## Monorepo layout

Bun workspaces (`bun@1.4.0`) with turborepo.

```
apps/
  api/        @metro-labs/api     api.metro.box: sign-in, organizations, agent list, launcher, Postgres
  daemon/     @metro-labs/daemon  what `metro serve` runs on a box
  ui/         @metro-labs/ui      the page at metro.box (Vite + react-native-web + @stage-labs/kit)
packages/
  core/       @metro-labs/core    the kernel every process shares; the only import a station may use
  http/       @metro-labs/http    how a metro server authenticates and answers a request
  cli/        @stage-labs/metro   the CLI, the only published package
  xmtp/ telegram-bot/ telegram/ discord-bot/ whatsapp/ threema/ outlook/ gmail/ webhook/
              one package per chat network
plugin/       the Claude Code plugin, shipped inside the CLI package
docs/         SETUP.md, ISSUING-SERVERS.md, MICROSOFT-365.md, GMAIL.md
```

Each package has its own README: [apps/daemon](apps/daemon/README.md),
[apps/app](apps/app/README.md), and one per chat network under `packages/`.

## Development

```sh
bun install
bun apps/daemon/src/server.ts          # a daemon on http://127.0.0.1:8420
bun --filter @metro-labs/api start     # api.metro.box locally; needs DATABASE_URL
cd apps/app && bun run web             # the app on http://localhost:8081
```

The gate. All of it must pass before a pull request:

```sh
bun run build && bun run typecheck && bun run lint && bun run knip && bun run madge && bun run test
```

Always commit `bun.lock`: CI and Docker install with `--frozen-lockfile`.

## Deploy

- **apps/api** is the Fly app `metro`, served as api.metro.box. Merging to `main` deploys
  it. Fly runs the database migrations first (`bun --filter @metro-labs/api db:migrate`,
  the `release_command` in `fly.toml`); a failed migration aborts the deploy and the old
  version keeps serving. Secrets: `DATABASE_URL`, `WORKOS_API_KEY` and `WORKOS_CLIENT_ID`, plus the four of
  [docs/ISSUING-SERVERS.md](docs/ISSUING-SERVERS.md) to launch boxes.
- **apps/app** is deployed to https://metro.box on Netlify (the Expo web export, set by
  the root `netlify.toml`). Every pull request gets a deploy preview. The phone app runs
  in a dev client: `App dev client APK` builds an APK when the native runtime changes,
  and `App preview` publishes every push as an EAS Update for that branch.
- **apps/bundler** serves https://bundler.metro.box/main and `/<branch>` for the dev
  client. It proxies the branch's EAS Update with the phone's Expo platform and runtime
  headers. Browsers get an Open in dev client button and a QR code. No dev server runs.
  The `Deploy bundler` workflow deploys the `metro-bundler` Cloudflare Worker from main
  when its code or launcher changes, or through Run workflow after the first setup.
  Add the repository secret `CLOUDFLARE_API_TOKEN`, scoped to the metro.box account and
  zone with Workers Scripts Edit, Zone Read and DNS Read. The
  workflow discovers the account from that zone and refuses conflicting DNS records
  or custom domains. The Worker's Custom Domain creates its DNS record and certificate.
  Expo updates and the installed APK runtime are unchanged. Verify DNS, TLS and a
  manifest with the installed APK's runtime after deployment.
- **The CLI** (`@stage-labs/metro`) is published by hand with the "Publish
  @stage-labs/metro" workflow in the GitHub Actions tab. It always publishes under the
  `beta` tag. Boxes pick it up with `metro update` or the Update button on the page.

## License

MIT, except the Calibre font files in `apps/app/assets/fonts/`, which are licensed
separately.
