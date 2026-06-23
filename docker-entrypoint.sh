#!/bin/sh
# metro container entrypoint.
#  - ensures the volume dirs exist (HOME=/data → on the mounted volume)
#  - generates one train script per CONFIGURED station (the supervisor spawns
#    ~/.metro/trains-style scripts; unconfigured stations are skipped so they
#    don't crash-loop)
#  - execs the single metro process (stations + outbox + webhooks + MCP, :8420)
set -e

mkdir -p "$HOME/.metro" "$HOME/.cache/metro" "$METRO_TRAINS_DIR"

# Train stubs use bare specifiers (e.g. `import '@metro-labs/xmtp/train'`). Bun
# resolves bare specifiers relative to the importing FILE's directory (not cwd), so
# the train dir needs a node_modules on its resolution path. Bun's workspace install
# hoists the @metro-labs/* symlinks into apps/mcp/node_modules, so point the train
# dir's node_modules at it. Idempotent.
if [ ! -e "$METRO_TRAINS_DIR/node_modules" ]; then
  ln -s /app/apps/mcp/node_modules "$METRO_TRAINS_DIR/node_modules"
fi

# Clear any stale singleton lock from an ungraceful stop. Safe on Fly: the
# single-attach volume guarantees one machine (one metro) at a time, so there's
# never a real concurrent holder — but the PID-liveness check is unreliable across
# container restarts (PIDs get reused), so a leftover lock would wrongly block boot.
rm -f "${METRO_STATE_DIR:-$HOME/.cache/metro}/.tail-lock"

if [ -n "$MNEMONIC" ]; then
  echo "import '@metro-labs/xmtp/train';" > "$METRO_TRAINS_DIR/xmtp.ts"
fi
if [ -n "$TELEGRAM_BOT_TOKENS" ]; then
  echo "import '@metro-labs/telegram/train';" > "$METRO_TRAINS_DIR/telegram.ts"
fi
if [ -n "$DISCORD_BOT_TOKENS" ]; then
  echo "import '@metro-labs/discord/train';" > "$METRO_TRAINS_DIR/discord.ts"
fi

exec bun /app/apps/mcp/src/server.ts
