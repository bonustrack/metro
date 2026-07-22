# @metro-labs/ui

A minimal web app that unlocks with a Metro API key and lists the accounts that key can see. It is an **MCP client**, not a new REST API: it connects to Metro's existing `/mcp` streamable-HTTP endpoint and calls the `list_accounts` tool. No new server endpoints are added.

## How it works

- Login screen with a single password field, which is your Metro **API key**.
- On submit it opens an MCP session against `VITE_METRO_MCP_URL` (default `/mcp`, same-origin) using `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport`, then calls `list_accounts`.
- On success it renders the returned accounts grouped by station.
- On a bad key the `/mcp` gate replies `401` during connect, and the app shows "Invalid API key" and stays on the login screen.

### Auth scheme

Metro's `/mcp` gate authenticates with the key as a **query parameter**: `GET/POST /mcp?token=<API_KEY>` (see `apps/mcp/src/mcp/index.ts` `authorized()`). It does **not** read an `Authorization: Bearer` header on `/mcp`. The client therefore puts the key in the URL query string. The key lives only in React state for the session (memory only) — it is never written to storage.

### Account scoping

`list_accounts` returns the accounts loaded by the daemon that answers the request (`gatherAccounts` over that daemon's stations). Metro's production model is **one daemon per agent** (`METRO_AGENT` pins the agent, and that agent's first key becomes the `?token=` value), so the accounts shown are that key's agent's accounts. If a single daemon is run without `METRO_AGENT` (all agents loaded, one shared token), `list_accounts` is scoped to the daemon, not to individual keys.

### Secrets

`list_accounts` is public-identity only by contract (addresses, bot ids/usernames — never tokens, mnemonics, sessions, or creds). As defense in depth the UI additionally drops any field whose key matches secret-ish names (`token`, `secret`, `key`, `mnemonic`, `private`, `session`, `apihash`, `apiid`, `cred`, `password`, `derive`, `passphrase`, `seed`) before rendering.

## Run locally

The MCP endpoint must be reached **same-origin** so the browser skips CORS. In dev, Vite proxies `/mcp` to a running daemon:

```
# terminal 1: a Metro daemon (needs DATABASE_URL), listening on :8420
bun apps/mcp/src/server.ts

# terminal 2
cd apps/ui
METRO_MCP_PROXY_TARGET=http://127.0.0.1:8420 bun run dev
# open http://localhost:5175, paste an API key from the daemon's agent
```

`METRO_MCP_PROXY_TARGET` defaults to `http://127.0.0.1:8420`.

## Build / deploy

```
bun run build   # -> apps/ui/dist (static SPA)
```

Serve `dist/` **same-origin with the daemon** (reverse proxy `/` to the static build and `/mcp` to the daemon), or set `VITE_METRO_MCP_URL` to the daemon's absolute `/mcp` URL. Note: if the UI is served from a **different origin** than the daemon, the browser will send a CORS preflight to `/mcp`, and Metro's HTTP server does not currently emit CORS headers or handle `OPTIONS` on `/mcp` — same-origin is the supported path. Cross-origin would require adding CORS to the daemon (out of scope here; flagged for a follow-up decision).

## Design

Styling comes from `@stage-labs/kit`, the Stage design system's React Native component family (Box/Row/Col, Text, Button, Input, Card), rendered on the web via `react-native-web`. Vite aliases `react-native` to `react-native-web` and resolves `.web.tsx` first; the app uses the kit's real RN primitives (`View`/`Text`/`TextInput`/`Pressable`) rather than raw DOM.
