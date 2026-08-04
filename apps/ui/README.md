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
- The dashboard is **two panes**. The left sidebar holds the agent list and nothing else,
  one row per agent with its account count, under a header row whose right-hand side is the
  **New agent** button. That button is the create entry point and is rendered in every
  state — none, one, many — never only in the empty state, and it sits above the list so a
  long list cannot scroll it out of view. Everything else
  belongs to the agent you pick and lives in the main pane: its accounts grouped by station,
  its MCP endpoint, its API key, the paste-ready `claude mcp add …` line and its **Delete**
  button. Accounts are never listed globally, so which account belongs to which agent is
  structural rather than something you infer.
- The selected agent is **in the URL**: `metro.box/#/1` is agent `1`, `#/2` is agent `2`,
  `#/new` is the create form and `#/` is the no-selection state. Picking an agent pushes a
  history entry, so Back and Forward walk the selection and a link to `#/2` opens straight
  on that agent. An id nobody can resolve, one that does not exist as much as one that exists
  but belongs to somebody else, renders the **same** message, *No agent with that id is
  available to this account*, because the browser never asks the daemon about a specific id:
  it only ever receives the list it is allowed to see, so there is nothing to leak. Routing
  is `window.location.hash` plus `history.pushState` (`src/route.ts`), with no router
  dependency, and it does not collide with the `#session=…` sign-in fragment, which is
  consumed and stripped before the dashboard mounts.
- Creating an agent `POST`s `/api/agents` with the chosen name, selects the new agent, and
  shows the generated API key and `claude mcp add …` command in the clear once. The key
  stays available afterwards on the agent's own pane, masked behind **Reveal**, and `GET`
  re-serves it for agents you own.
- Each agent you **own** carries a **Delete agent** button that asks for confirmation in
  place before it fires `DELETE /api/agents/<id>`. Deleting revokes that agent's API key
  immediately and clears the selection. Agents shown as *granted, not owned* have no delete
  button and no key (only the endpoint), and the daemon refuses the call anyway.
- The four states the main pane can be in: **no agents at all** → the create form, titled
  *Create your first agent*; **no agent selected** (you just deleted the one you were
  looking at, or you are on `#/`) → a prompt to pick one on the left, carrying its own
  **New agent** button so that state is never a dead end; **a routed id this account cannot
  resolve** → the neutral not-available message with the same **New agent** button;
  **an agent with no accounts** → its
  credentials plus a line saying no chat account is connected yet; **a granted agent** →
  its endpoint, no key.
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

An agent's `name` is a display label and nothing else: it is stored with the casing typed
into the form, it carries no unique index, and two agents, even two owned by the same
person, may share one. Everything that decides what a session may see or delete compares
`agents.id`.

An agent created here records the creator in `agents.owner_id`, the `users` row for their
verified Google email (created on first sign-in, one row per address).
`/api/agents` returns only the agents whose `owner_id` is that row, plus
any agent names granted to that email through the daemon's `GOOGLE_EMAIL_AGENTS` map (shown
as not-owned). Accounts are filtered to that same set of agents, server-side, and each one
comes back stamped with the `agentId` it belongs to, which is what the sidebar/main split
renders, so the browser never guesses the pairing. A signed-in user with no agents sees an
empty sidebar and the create form, never anyone else's data.

An account the daemon does not attribute is shown under **no** agent rather than under a
guessed one. The single exception is deliberate and safe: when the session can see exactly
one agent, every account in the payload is by construction that agent's, so an untagged row
is attributed to it. That is what keeps this UI working against a daemon that predates the
`agentId` field; with more than one agent visible such rows are counted and reported instead
of shown.

Sign-in is open to any Google account with a verified email, on any domain, and there is no
cap on how many agents one email owns. Deletion is owner-only and keyed on `agents.id`:
someone else's agent id is a `404`, and an operator-provisioned row (`owner_id IS NULL`)
is refused even for a session that can see it through `GOOGLE_EMAIL_AGENTS`.

## Config

- `VITE_METRO_MCP_URL` — the daemon base URL (default `https://mcp.metro.box`); its origin
  is also where the sign-in redirect and `/api/agents` point.

The daemon (apps/mcp) needs `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and
`METRO_SESSION_SECRET`; `GOOGLE_EMAIL_AGENTS` is optional (see repo `.env.example`).

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

Kit `Button` resolves its colours from a `dark` prop that defaults to `false`, exactly like
`Card` does — it does not read the theme context. Every `<Button>` here therefore passes
`dark={useKitScheme() === 'dark'}`. Omitting it paints a light-scheme button on the dark
page: a `primary` one comes out pure black on the near-black background, which is how a
visible control becomes an invisible one. Pass `dark` on every new button.
