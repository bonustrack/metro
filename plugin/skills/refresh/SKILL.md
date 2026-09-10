---
name: refresh
description: Rewrite the plugin's MCP servers from the metro daemon's connector list by hand, for when the daemon could not keep the list current itself.
---

The metro daemon writes this plugin's MCP server list itself whenever a connector is added, renamed or removed, so this is the fallback for when it could not: the daemon was not running at the time, or a plugin update reset the file.

1. Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" refresh
```

2. On success, relay the script's output verbatim and tell the user the new list reaches a Claude Code session started after it. `/reload-plugins` does not re-read a plugin's server list, so a running session keeps the old one. You cannot restart their session for them.
3. If the script says there is no daemon, tell the user to start one with `metro serve` and stop. If it says there is no agent yet, tell them to create or restore one in the web UI the daemon links to.
