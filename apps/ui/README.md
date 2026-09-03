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
  `#/new` is the create form, `#/start` is the Claude Code page and `#/` is the
  no-selection state. Picking an agent pushes a
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
  immediately and clears the selection.
- The four states the main pane can be in: **no agents at all** → the create form, titled
  *Create your first agent*; **no agent selected** (you just deleted the one you were
  looking at, or you are on `#/`) → a prompt to pick one on the left, carrying its own
  **New agent** button so that state is never a dead end; **a routed id this account cannot
  resolve** → the neutral not-available message with the same **New agent** button;
  **an agent with no stations** → its
  credentials plus a line saying no station is connected yet.
- **Start a Claude Code session** is a page of its own at `#/start`, reached from the
  **Claude Code** button in the top bar. It leads with the command that starts a session
  with the Metro channel enabled, carries the `-c` resume variant under it, and then lists
  what has to exist first: an agent with a key, a station attached to it, the server
  registered locally under the name `metro`, a recent Claude Code on first-party auth, and
  telemetry left on. The registration line it shows is built from the daemon's own endpoint
  with a **placeholder where the key goes** (`src/components/start-session.ts`, pinned by
  `test/start-session.test.ts`); the real key is only ever on the agent's own page. It is
  the one route that stays reachable with **no agents yet**, since a first-time visitor is
  exactly who needs it.
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
`/api/agents` returns only the agents whose `owner_id` is that row. Operator-provisioned
rows (`owner_id IS NULL`) are not listed to anybody.
Accounts are filtered to that same set of agents, server-side, and each one
comes back stamped with the `agentId` it belongs to, which is what the sidebar/main split
renders, so the browser never guesses the pairing. A signed-in user with no agents sees an
empty sidebar and the create form, never anyone else's data.

An account the daemon does not attribute is shown under **no** agent rather than under a
guessed one. The single exception is deliberate and safe: when the session can see exactly
one agent, every account in the payload is by construction that agent's, so an untagged row
is attributed to it. That is what keeps this UI working against a daemon that predates the
`agentId` field; with more than one agent visible such rows are counted and reported instead
of shown.

Sign-in is Sign-In with Ethereum: any wallet may sign in (browser extensions found through
EIP-6963, WalletConnect, Coinbase Wallet), and there is no cap on how many agents one
address owns. Deletion is owner-only and keyed on `agents.id`: someone else's agent id is a
`404`.

## Config

- `VITE_METRO_MCP_URL` — the daemon base URL (default `https://mcp.metro.box`); the sign-in
  routes and `/api/agents` live there.
- `VITE_WC_PROJECT_ID` — overrides the built-in Reown project id used by WalletConnect.

The daemon (apps/mcp) needs `METRO_SESSION_SECRET` (see repo `.env.example`).

## Run locally

```
# terminal 1: a Metro daemon on :8420 (DATABASE_URL + METRO_SESSION_SECRET)
bun apps/mcp/src/server.ts

# terminal 2
cd apps/ui
VITE_METRO_MCP_URL=http://localhost:8420 bun run dev   # http://localhost:5175
```

Register `http://localhost:8420/auth/google/callback` as a redirect URI on the OAuth client
for local sign-in; localhost `return_to` is allowed by default.

### Any daemon, not just the built-in one

Open `#/connect` (or the `#/connect/<url>` link a `METRO_MODE=local` daemon prints at boot) and
enter the daemon's address. Plain http is accepted for loopback only, so from another computer
forward the port first (`ssh -L 8420:127.0.0.1:8420 <host>`); https addresses are accepted
anywhere. The address and the session it signed in with are kept per daemon in localStorage, and
`GET /api/mode` tells the pages which kind of daemon they are on, so a local one hides connectors,
members and project settings, which it does not serve.

## Build / deploy

```
bun run build   # -> apps/ui/dist (static SPA)
```

The daemon emits CORS on `/api/agents` and `/mcp`, so the UI runs cross-origin from the
daemon. Deploy previews work once metro.box's daemon has the callback + envs.

## Design

Styling comes from `@stage-labs/kit`, rendered on the web via `react-native-web`.

### Type

`src/theme.ts` owns the panel's type, and `src/components/ui.tsx` is where it is applied.
Import `Text`, `Button` and `Input` from `./ui`, never from the kit directly, or the
component drops out of the font stack and the size scale.

`TYPE_SCALE` is the single knob for text size — it multiplies every size the kit resolves,
so all of them move together and the proportions of the scale hold. It is `16 / 15`: one
step up the kit's own scale, 15px body text rendering at 16px.

Button labels are centred by `src/index.css`, not by a line height. A pill is a
fixed-height flex row with `align-items: center`, so the browser centres the label's *line
box* — and that box is not symmetric around the letters. Its height is the font's ascent +
descent + line gap, the baseline sits at `ascent + floor(halfLeading)` (Blink floors it, so
an odd leading drops one more pixel below the text than above), and on top of that every
family has its own gap between the ascent and the cap height, which is rarely equal to its
descent. The result is that identical markup reads centred in one font and high in another:
in Calibre the leading is exactly 3px at both button sizes, so the cap band lands 1.21px
off in a 32px pill.

An explicit `lineHeight` does **not** fix this, and an earlier revision of this file
claiming it does was wrong. The leading's parity depends on the font's own rounded ascent
and descent, so a value that splits evenly in one family splits odd in the next; measured
across five families it fixed some sizes and broke others.

`text-box-trim` is the property built for the problem. It trims the line box to the cap
height on top and the alphabetic baseline underneath, so the box the flex row centres *is*
the band the eye reads, derived by the browser from each font's own metrics — no per-font
nudge, and correct for Calibre and every fallback alike. The trimmed box stops at the
baseline and the label carries `overflow: hidden` from `numberOfLines={1}`, which would cut
the tails off g/j/p/q/y, so a symmetric `padding-block` gives them room back without moving
the cap band. It is behind `@supports` so a browser without the property renders exactly as
it did before rather than getting the padding on its own.

What is left is Chrome's own pixel grid: it paints the baseline snapped to a whole CSS
pixel at every DPR, so when the ideal baseline falls mid-pixel the label can still sit up to
half a pixel off. That residual is not tunable from CSS — do not chase it with a `marginTop`
or a `translateY`, and do not special-case a font.

Cards take their inset from `CARD_PADDING` (`CARD_PADDING_ROW` for sidebar rows,
`CARD_PADDING_PANEL` for the signed-out panel) rather than a literal, so stacked cards line
up down the page instead of drifting a few pixels apart.

### Fonts

**Calibre is self-hosted from this repo.** The kit names its families `Calibre-Medium`,
`Calibre-Semibold` and `Menlo`, and ships no `@font-face` for any of them. A bare family
name only resolves on a machine that has the font installed locally, so before the faces
below existed the panel rendered in Calibre on a designer's laptop and in the platform UI
font — or, before the stack in `src/theme.ts`, in the browser's default serif — on a phone,
a second laptop, or Windows.

The two files live in `public/fonts/`, so Vite copies them verbatim into `dist/fonts/` and
they are served from a stable path that `index.html` can preload:

| file | bytes |
| --- | --- |
| `public/fonts/Calibre-Medium.woff2` | 17328 |
| `public/fonts/Calibre-Semibold.woff2` | 19264 |

They are byte-identical to the subset build snapshot.box ships — `Calibre-Medium-Custom.woff2`
and `Calibre-Semibold-Custom.woff2` under `packages/tune/src/assets/fonts/` in `sx-monorepo`
— 447 glyphs over 370 codepoints. Calibre is a commercial Klim Type Foundry face: the repo's
MIT `LICENSE` covers the source, not these two files, which are here under Snapshot Labs'
own Klim licence. Do not copy them out into another project.

`src/index.css`, imported from `src/main.tsx`, declares them:

```css
@font-face {
  font-family: 'Calibre-Medium';
  src: url('/fonts/Calibre-Medium.woff2') format('woff2');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Calibre-Semibold';
  src: url('/fonts/Calibre-Semibold.woff2') format('woff2');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
```

plus a preload for the primary weight in `index.html`:

```html
<link rel="preload" href="/fonts/Calibre-Medium.woff2" as="font" type="font/woff2" crossorigin />
```

Two rules hold this shape together and neither is cosmetic.

**One face per family, at `font-weight: normal`.** The kit hardcodes the family *names*
`Calibre-Medium` and `Calibre-Semibold` — in `text.styles.ts`, `button.styles.ts`,
`control.styles.ts` and a dozen components — and never sets a `fontWeight`. So a single
`Calibre` family declared at 500/600, which is how `packages/tune` does it in `sx-monorepo`,
would match nothing here and every label would fall through to the system stack. Declaring
each face as its own family at `normal` is what makes the kit's names resolve, and because
nothing ever asks for a bolder weight than the face provides, no browser synthesises a
fake bold over the real Semibold. Do not merge them into one family, and do not add a
`font-weight` axis.

**No `local()` source.** Resolving an installed copy first is what hid the original bug: a
machine with Calibre rendered correctly whatever the CSS said. It is also non-deterministic
— these are subsets, a retail install is not, and the button centring in Type above is
derived from whichever file the browser actually picked. Every machine downloads the same
36 KB and renders the same metrics.

`FONT_SANS` / `FONT_HEAD` / `FONT_MONO` in `src/theme.ts` keep the Calibre family first and
the platform UI font behind it. That stack is still load-bearing: it is what renders if the
font request fails, and it is the per-character fallback for anything outside the subset.

To check the faces are really loading rather than a local install masking a broken path,
use a machine that does **not** have Calibre — `document.fonts` should report both families
`loaded`, and Chrome DevTools' computed-font readout should name `Calibre Medium` /
`Calibre Semibold` as *network resources*.

Vertical metrics are a separate axis and Calibre is not exempt. Its numbers are 1000 upem,
typo ascender 800, descender −200, line gap 200, `USE_TYPO_METRICS` set, cap height 614 — a
1.2em `normal` line box whose leading is odd at every size the panel uses. See Type above:
`text-box-trim` derives the cap band from exactly those numbers, so it stayed correct when
the real font arrived (measured: the cap band centres to within 0.011px of the pill centre
at both button sizes), and the 1.21px the untrimmed path is off by in a 32px pill is
Calibre's figure, measured with the real face.

Kit `Button` resolves its colours from a `dark` prop that defaults to `false`, exactly like
`Card` does — it does not read the theme context. Every `<Button>` here therefore passes
`dark={useKitScheme() === 'dark'}`. Omitting it paints a light-scheme button on the dark
page: a `primary` one comes out pure black on the near-black background, which is how a
visible control becomes an invisible one. Pass `dark` on every new button.
