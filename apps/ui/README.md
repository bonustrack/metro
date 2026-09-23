# @metro-labs/ui

The page at https://metro.box. It manages your Metro agents: each agent is a box running
`metro serve`, and the page talks to that box directly over its own address.

It is a Vite app built with `@stage-labs/kit` rendered on the web through
`react-native-web`.

## How it works

- **Sign-in** goes through api.metro.box, which uses WorkOS (Google, Microsoft or GitHub).
  The page keeps the tokens in localStorage (`metro.account`) and sends
  `Authorization: Bearer <token>` to api.metro.box and to every box. There are no cookies.
- **Organizations.** A signed-in user works in one organization at a time. Every address
  starts with the organization's slug, as in `#/stage-labs/<agent>/server`. A box only
  accepts tokens for the organization in its `~/.metro/agents/.owner`.
- **The agent list** lives on api.metro.box (`/api/servers`). Each agent has a slug, and
  its pages are `#/<organization>/<agent>/…`: Agent, Settings, Server, Model, Harness,
  Terminal, Skills, Channels, Connectors, Memory and Sessions.
- **Talking to a box** uses plain `fetch` to the box's JSON routes. The page is not an MCP
  client, and must not become one.
- **New agent** asks api.metro.box to launch a box on AWS (see
  [docs/ISSUING-SERVERS.md](../../docs/ISSUING-SERVERS.md)). **Import agent** adds a box
  that already runs, by its address.

## Config

- `VITE_METRO_MCP_URL`: the api.metro.box base URL. Defaults to `https://api.metro.box`.

## Run locally

```sh
bun apps/daemon/src/server.ts      # a daemon on http://127.0.0.1:8420
cd apps/ui && bun run dev          # the page on http://localhost:5175
```

## Build and deploy

```sh
bun run build   # -> apps/ui/dist, a static site
```

It is deployed to https://metro.box on Netlify.

## Design rules

- Import `Text`, `Button` and `Input` from `src/components/ui.tsx`, never from the kit
  directly, so the font and the size scale apply.
- `TYPE_SCALE` in `src/theme.ts` is the one knob for text size.
- Every colour comes from the kit palette through `theme-mode.tsx`. Do not write colours by
  hand.
- Inline style objects in JSX are a lint error. Use the kit's `Box` props, or a named
  constant.

## Fonts

The page uses Calibre only, self-hosted from `public/fonts/` (`Calibre-Medium.woff2` and
`Calibre-Semibold.woff2`). Each file is its own font family at `font-weight: normal`,
under the names the kit uses. Calibre is licensed to Snapshot Labs: the repo's MIT license
does not cover these two files, so do not copy them into another project.
