---
name: refresh
description: Re-read the agent's connector list from the metro daemon on this machine and rewrite the plugin's MCP servers, picking up added or removed connectors.
---

Refresh the plugin's MCP server list from the metro daemon running on this machine.

1. Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" refresh
```

2. On success, relay the script's output verbatim and remind the user to run `/reload-plugins` — unchanged servers keep their live connections, added ones connect, removed ones disconnect. You cannot run that command for them.
3. If the script says there is no daemon, tell the user to start one with `metro serve` and stop. If it says there is no agent yet, tell them to create or restore one in the web UI the daemon links to.

Use this after connectors were added to or removed from the agent, or after a plugin update reset the server list.
