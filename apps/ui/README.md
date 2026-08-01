# @metro-labs/ui

The Metro control panel. Sign in with Google, create an agent by naming it, get its API
key and the exact `claude mcp add …` line, and see the accounts attached to the agents you
own.

It talks to **one session-gated JSON route on the daemon** (`/api/agents`). It is **not**
an MCP client — see [Why this is not an MCP client](#why-this-is-not-an-mcp-client).
Sign-in uses the **server-side OAuth authorization-code flow** handled by the daemon, so
the UI ships no Google JavaScript at all.

## How it works

- The gate is a single **Continue with Google** button. It navigates the browser to
  `<daemon>/auth/google/start?return_to=<this origin+path>`.
- The daemon runs the OAuth code flow with Google (redirect URI
  `https://mcp.metro.box/auth/google/callback`), verifies the returned ID token, mints a
  **daemon-signed session JWT** (HS256), and redirects back to `return_to` with the token
  in the **URL fragment** (`#session=…`).
- On load the app reads `#session` from the fragment, stores it in `localStorage`
  (`metro.session`), and immediately strips the fragment from history
  (`history.replaceState`). It then `GET`s `/api/agents` with
  `Authorization: Bearer <session>`.
- The dashboard lists the agents that session may see, their accounts grouped by station,
  and a **New agent** form. Creating one `POST`s `/api/agents` with the chosen name; the
  response carries the generated API key and the `claude mcp add …` command **once**.
  Nothing ever re-reveals that key — subsequent `GET`s return key *names* only.
- **Log out** clears the stored session. A returning visitor with a still-fresh stored
  session auto-connects (spinner, no gate). An expired/invalid session gets a `401`, is
  cleared, and the gate returns.

### Why this is not an MCP client

The daemon hosts a **single** MCP `Server` with a single streamable-HTTP transport, and it
rebinds that transport on every `initialize`. An MCP client in the browser therefore stole
the running agent's MCP session on every dashboard page load. This app deliberately uses
plain `fetch` against `/api/agents` instead, which is mounted before the MCP auth gate and
never touches the transport. Do not reintroduce an MCP client here.

### Why the token comes back in the URL fragment

The UI (metro.box, and especially `deploy-preview-N--metro-ui.netlify.app`) is a
**different origin** from the daemon (`mcp.metro.box`), so a `SameSite` cookie set by the
daemon would not be sent by the UI's cross-origin requests. The fragment (`#session=…`) is
never sent to any server, is readable only by the destination page, and is stripped from
history on arrival. `return_to` is validated server-side (metro.box,
`*--metro-ui.netlify.app`, localhost only) and carried inside a signed `state`, so the
callback cannot be turned into an open redirect.

### Ownership

An agent created here records the creator's verified Google email in `agents.owner_email`.
`/api/agents` returns only the agents whose `owner_email` matches the session's email, plus
any agent names granted to that email through the daemon's `GOOGLE_EMAIL_AGENTS` map (shown
as not-owned). Accounts are filtered to that same set of agents, server-side. A signed-in
user with no agents sees an empty dashboard and the create form — never anyone else's data.

## Config

- `VITE_METRO_MCP_URL` — the daemon base URL (default `https://mcp.metro.box`); its origin
  is also where the sign-in redirect and `/api/agents` point.

The daemon (apps/mcp) needs `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and
`METRO_SESSION_SECRET`; `GOOGLE_EMAIL_AGENTS`, `METRO_SIGNIN_DOMAINS` and
`METRO_MAX_AGENTS_PER_OWNER` are optional (see repo `.env.example`).

## Run locally

```
# terminal 1: a Metro daemon on :8420 (DATABASE_URL + the Google/session envs above)
bun apps/mcp/src/server.ts

# terminal 2
cd apps/ui
VITE_METRO_MCP_URL=http://localhost:8420 bun run dev   # http://localhost:5175
```

Register `http://localhost:8420/auth/google/callback` as a redirect URI on the OAuth client
for local sign-in; localhost `return_to` is allowed by default.

## Build / deploy

```
bun run build   # -> apps/ui/dist (static SPA)
```

The daemon emits CORS on `/api/agents` and `/mcp`, so the UI runs cross-origin from the
daemon. Deploy previews work once metro.box's daemon has the callback + envs.

## Design

Styling comes from `@stage-labs/kit`, rendered on the web via `react-native-web`.
