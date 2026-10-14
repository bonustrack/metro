# Organization connectors

Every connector belongs to an organization and lives in api.metro.box's Postgres, sealed
with `METRO_CONNECTORS_KEY`. Admins add, sign in, assign and set permissions on the
organization's Connectors page. An agent receives only the connectors assigned to it.

## How an agent gets its connectors

1. The agent is enrolled in its organization (Server page, Enroll). Enrolling gives it its
   own signing and sealing keys, kept in Metro's folder on the box.
2. Sync is on (Server page). The daemon then asks api.metro.box for a sealed snapshot of
   its assigned connectors, about once a minute, and keeps the credentials in memory only.
3. The daemon publishes each connector to Claude Code as its own MCP server, at
   `http://127.0.0.1:8420/relay/org-<id>`, through the metro plugin's `.mcp.json`. That
   file holds no credential.
4. Every tool call fetches a fresh delivery, is checked against the organization's and the
   agent's permissions (the stricter wins), and goes from the box to the vendor directly.

## Things to know

- The list Claude Code sees changes only when an assignment changes. A lapsed delivery or a
  short api.metro.box outage keeps the list; calls answer 503 until the next delivery.
- After an update, the Claude session starts once the list is published (30 seconds at most).
- Tool names are `mcp__plugin_metro_<server key>__<tool>`. Server keys are kept in
  `<agents dir>/connector-server-keys.json` with its `connector-server-keys.initialized`
  marker; keep both together when backing up or restoring.
- Sign-ins moved from boxes during the 2026 migration keep their original OAuth client and
  are refreshed by api.metro.box. Never restore an old local token copy.

## History

Until 2026-10-14 each box kept its own connectors (`connectors.json`) and moved them with
"Move to organization". That code is gone; see docs/HISTORY.md.
