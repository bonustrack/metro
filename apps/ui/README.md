# @metro-labs/ui

A minimal web app that signs in with Google and lists the Metro accounts the signed-in identity is allowed to see. It is an **MCP client**, not a new REST API: it connects to Metro's `/mcp` streamable-HTTP endpoint and calls `list_accounts`. Sign-in uses the **server-side OAuth authorization-code flow** handled by the daemon — the UI ships no Google JavaScript at all.

## How it works

- The gate is a single **Continue with Google** button. It navigates the browser to `<daemon>/auth/google/start?return_to=<this origin+path>`.
- The daemon runs the OAuth code flow with Google (redirect URI `https://mcp.metro.box/auth/google/callback`), verifies the returned ID token, maps the verified email to allowed agent name(s), mints a **daemon-signed session JWT** (HS256), and redirects back to `return_to` with the token in the **URL fragment** (`#session=…`).
- On load the app reads `#session` from the fragment, stores it in `localStorage` (`metro.session`), and immediately strips the fragment from history (`history.replaceState`). It then opens an MCP session passing the token as `?token=` and calls `list_accounts`.
- Accounts render grouped by station. **Log out** clears the stored session.
- A returning visitor with a still-fresh stored session auto-connects (spinner, no gate). An expired/invalid session gets a `401`, is cleared, and the gate returns. If the daemon redirects back with `#error=unauthorized` (email not mapped), the gate shows that.

### Why the token comes back in the URL fragment

The UI (metro.box, and especially `deploy-preview-N--metro-ui.netlify.app`) is a **different origin** from the daemon (`mcp.metro.box`), so a `SameSite` cookie set by the daemon would not be sent by the UI's cross-origin MCP requests. The fragment (`#session=…`) is never sent to any server, is readable only by the destination page, and is stripped from history on arrival. `return_to` is validated server-side (metro.box, `*--metro-ui.netlify.app`, localhost only) and carried inside a signed `state`, so the callback cannot be turned into an open redirect.

### Account scoping

The session JWT carries the allowed agent name(s). The daemon filters `list_accounts` to those agents and rejects `line`-addressed operations outside them. Production runs one daemon per agent (`METRO_AGENT`), so in practice the mapped agent's accounts are the daemon's accounts.

## Config

- `VITE_METRO_MCP_URL` — the daemon base URL (default `https://mcp.metro.box`); its origin is also where the sign-in redirect points. No Google client id is needed in the UI build anymore.

The daemon (apps/mcp) needs `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_EMAIL_AGENTS`, and `METRO_SESSION_SECRET` (see repo `.env.example`).

## Run locally

```
# terminal 1: a Metro daemon on :8420 (DATABASE_URL + the Google/session envs above)
bun apps/mcp/src/server.ts

# terminal 2
cd apps/ui
VITE_METRO_MCP_URL=http://localhost:8420 bun run dev   # http://localhost:5175
```

Register `http://localhost:8420/auth/google/callback` as a redirect URI on the OAuth client for local sign-in; localhost `return_to` is allowed by default.

## Build / deploy

```
bun run build   # -> apps/ui/dist (static SPA)
```

The daemon emits CORS on `/mcp`, so the UI runs cross-origin from the daemon. Deploy previews work once metro.box's daemon has the callback + envs.

## Design

Styling comes from `@stage-labs/kit`, rendered on the web via `react-native-web`.
