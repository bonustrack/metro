---
name: refresh
description: Re-fetch the metro collection's connector list and rewrite the plugin's MCP servers, picking up added or removed connectors.
---

Refresh the plugin's MCP server list from metro.

1. Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" refresh
```

2. On success, relay the script's output verbatim and remind the user to run `/reload-plugins` — unchanged servers keep their live connections, added ones connect, removed ones disconnect. You cannot run that command for them.
3. If the script says the machine is not signed in, point the user at `/metro:login` and stop.

Use this after connectors were added to or removed from the collection on metro.box, or after a plugin update reset the server list.
