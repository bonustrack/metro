# Organization connectors

Every connector belongs to an organization and lives in api.metro.box's Postgres, sealed
with `METRO_CONNECTORS_KEY`. Admins add, sign in, assign and set permissions on the
organization's Connectors page. An agent reaches only the connectors assigned to it.

## How an agent gets its connectors

1. The agent is enrolled in its organization (Server page, Enroll). Enrolling gives it its
   own keys, kept in Metro's folder on the box.
2. The daemon makes the agent an MCP token and registers its hash with mcp.metro.box.
3. Claude Code reaches every assigned connector through one server, `mcp`
   (`https://mcp.metro.box`), which `metro claude` and the Agent SDK runner add at launch:
   `find_tools` to find a tool, `call_tool` to run it (`mcp__mcp__find_tools`,
   `mcp__mcp__call_tool` in Claude Code).
   Every call runs from mcp.metro.box, checked against the organization's and the agent's
   permissions (the stricter wins). Credentials never reach the box. Design:
   docs/MCP-SERVER.md.

## Things to know

- An assignment, a policy or a sign-in change reaches the agent at its next `find_tools`
  or `call_tool`; nothing needs a reload. Tool lists are kept 5 minutes on mcp.metro.box.
- Tool names are `<connector key>.<tool>`, the key being the slug of the connector's name.
- Sign-ins moved from boxes during the 2026 migration keep their original OAuth client and
  are refreshed centrally. Never restore an old local token copy.

## History

Until 2026-10-14 each box first kept its own connectors (`connectors.json`), then received
its organization connectors' credentials from api.metro.box and relayed every call itself,
one MCP server per connector. Both are gone; see docs/HISTORY.md.
