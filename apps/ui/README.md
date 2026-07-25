# @metro-labs/ui

A minimal web app that signs in with Google and lists the Metro accounts that the signed-in identity is allowed to see. It is an **MCP client**, not a new REST API: it connects to Metro's existing `/mcp` streamable-HTTP endpoint and calls the `list_accounts` tool. No new server endpoints are added.

## How it works

- The gate shows a **Sign in with Google** button (Google Identity Services).
- On sign-in, GIS returns a Google **ID token** (a JWT). The app opens an MCP session against `VITE_METRO_MCP_URL` (default `https://mcp.metro.box`) using `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport`, passing the ID token as the `?token=` credential, then calls `list_accounts`.
- On success it renders the returned accounts grouped by station.
- If the daemon rejects the identity (`401` — the email is not mapped to any agent, or the token is invalid/expired), the app shows "This Google account is not authorized for Metro." and returns to the gate.
- On a successful unlock the ID token is saved to `localStorage` (`metro.google.credential`), so a reload reconnects automatically (a centered spinner shows while it does). Google ID tokens expire ~1h, so on load the app only auto-reconnects when the stored token is still fresh; GIS `auto_select` re-issues a token silently where the browser allows it, otherwise the gate is shown. **Log out** clears the token and disables auto-select.

### Auth scheme

Metro's `/mcp` gate authenticates the credential as a **query parameter**: `GET/POST /mcp?token=<CREDENTIAL>` (see `apps/mcp/src/mcp/request-identity.ts`). The daemon accepts two credential kinds on that same parameter: a Metro **API key** (opaque — used by CLI/agents) or a **Google ID token** (a JWT — used by this UI). A JWT-shaped token is verified against Google's JWKS (`aud` == `GOOGLE_OAUTH_CLIENT_ID`, valid signature, not expired, `email_verified`), then the verified email is mapped to allowed agent name(s) via `GOOGLE_EMAIL_AGENTS`.

### Account scoping

For a Google identity, `list_accounts` is filtered to only the accounts owned by the agent name(s) the email maps to (`GOOGLE_EMAIL_AGENTS`), and `line`-addressed operations outside that scope are rejected. Metro's production model is still **one daemon per agent** (`METRO_AGENT`), so in practice the mapped agent's accounts are exactly the daemon's accounts.

### Secrets

`list_accounts` is public-identity only by contract (addresses, bot ids/usernames — never tokens, mnemonics, sessions, or creds). As defense in depth the UI additionally drops any field whose key matches secret-ish names before rendering.

## Config

Set at **build time** (Vite): `VITE_GOOGLE_CLIENT_ID` — the Google OAuth **Web** client id. Without it the gate renders a "Google sign-in is not configured" message. `VITE_METRO_MCP_URL` overrides the daemon URL (default `https://mcp.metro.box`).

The daemon (apps/mcp) must have the matching `GOOGLE_OAUTH_CLIENT_ID` and a `GOOGLE_EMAIL_AGENTS` map (see repo `.env.example`).

## Run locally

```
# terminal 1: a Metro daemon (needs DATABASE_URL, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_EMAIL_AGENTS), on :8420
bun apps/mcp/src/server.ts

# terminal 2
cd apps/ui
VITE_GOOGLE_CLIENT_ID=<web-client-id> METRO_MCP_PROXY_TARGET=http://127.0.0.1:8420 bun run dev
# open http://localhost:5175 (add http://localhost:5175 to the OAuth client's Authorized JS origins)
```

Vite proxies `/mcp` to `METRO_MCP_PROXY_TARGET` (default `http://127.0.0.1:8420`) so same-origin dev works.

## Build / deploy

```
VITE_GOOGLE_CLIENT_ID=<web-client-id> bun run build   # -> apps/ui/dist (static SPA)
```

Add the deployed origin (e.g. `https://metro.box`) to the OAuth client's Authorized JavaScript origins. The daemon emits CORS on `/mcp`, so the UI may be served cross-origin from the daemon (`VITE_METRO_MCP_URL` = absolute `/mcp` URL).

## Design

Styling comes from `@stage-labs/kit`, rendered on the web via `react-native-web`. The Google button is rendered by GIS into a leaf `<div>` inside the kit-styled card.
