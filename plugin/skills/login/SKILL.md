---
name: login
description: Authorize this machine for one metro agent and load that agent's connectors as MCP servers through metro's relay.
---

Sign this machine in to metro as one agent and load that agent's MCP servers.

1. If `$ARGUMENTS` is empty, do not run anything. Tell the user to get a pairing code (`ma_…`) for the agent from metro.box and run `/metro:login <code>`. Stop.
2. Otherwise run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" login $ARGUMENTS
```

3. On success, relay the script's output verbatim (it names the agent and the servers it wrote) and remind the user to run `/reload-plugins` so the servers connect in THIS session — you cannot run that command for them.
4. On failure, relay the script's error message exactly. A message about an expired or used code means the user must mint a fresh one on metro.box.

The pairing code is single-use and short-lived. The stored sign-in lands in `~/.config/metro/credentials.json`, shared with the `metro` CLI, and no connector credential ever reaches this machine — servers ride metro's relay.
