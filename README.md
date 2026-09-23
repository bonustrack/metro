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
- **webhook**: an inbound-only HTTP receiver. The code is there, but the page does not
  offer it yet.

Inbound messages reach the Claude Code session as channel events. The agent answers with
the `mcp__metro__*` tools: `send`, `reply`, `react`, `unreact`, `edit`, `delete`, `read`,
`list_members`, `create_group`, `add_members`, `remove_members`, `export_invite`,
`create_upload`, `list_accounts`, `set_profile` and `get_profile`. Support for each verb
depends on the network; an unsupported verb answers with the reason.

> `telegram` and `whatsapp` sign in as real user accounts. Their stored sessions are
> full-account secrets, both networks may ban an account used this way, and only one
> process may use an account at a time. Use an identity you can dedicate to the agent.

## The pieces

- **The daemon** (`apps/daemon`) runs on your box. It holds the agent, its channels and
  its connectors as files under `~/.metro/agents`. It serves MCP, the APIs the page uses,
  and a model gateway, and it runs one subprocess ("train") per chat network.
- **The page** at https://metro.box (`apps/ui`) manages your boxes. It talks to each
  daemon directly, over the daemon's own public address.
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
Codex (ChatGPT subscription) or Gemini.

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
| `metro tail <agent-id>` | Follow this machine's inbound events, one JSON line each. |
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
  xmtp/ telegram-bot/ telegram/ discord-bot/ whatsapp/ threema/ webhook/
              one package per chat network
plugin/       the Claude Code plugin, shipped inside the CLI package
docs/         SETUP.md, ISSUING-SERVERS.md, MICROSOFT-365.md
```

Each package has its own README: [apps/daemon](apps/daemon/README.md),
[apps/ui](apps/ui/README.md), and one per chat network under `packages/`.

## Development

```sh
bun install
bun apps/daemon/src/server.ts          # a daemon on http://127.0.0.1:8420
bun --filter @metro-labs/api start     # api.metro.box locally; needs DATABASE_URL
cd apps/ui && bun run dev              # the page on http://localhost:5175
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
- **apps/ui** is deployed to https://metro.box on Netlify.
- **The CLI** (`@stage-labs/metro`) is published by hand with the "Publish
  @stage-labs/metro" workflow in the GitHub Actions tab. It always publishes under the
  `beta` tag. Boxes pick it up with `metro update` or the Update button on the page.

## License

MIT, except the Calibre font files in `apps/ui/public/fonts/`, which are licensed
separately.
