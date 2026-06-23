#!/bin/sh
# metro container entrypoint.
#  - ensures the volume dirs exist (HOME=/data → on the mounted volume)
#  - generates one train script per CONFIGURED station (the supervisor spawns
#    ~/.metro/trains-style scripts; unconfigured stations are skipped so they
#    don't crash-loop)
#  - execs the single metro process (stations + outbox + webhooks + MCP, :8420)
set -e

mkdir -p "$HOME/.metro" "$HOME/.cache/metro" "$METRO_TRAINS_DIR"

# Clear any stale singleton lock from an ungraceful stop. Safe on Fly: the
# single-attach volume guarantees one machine (one metro) at a time, so there's
# never a real concurrent holder — but the PID-liveness check is unreliable across
# container restarts (PIDs get reused), so a leftover lock would wrongly block boot.
rm -f "${METRO_STATE_DIR:-$HOME/.cache/metro}/.tail-lock"

if [ -n "$MNEMONIC" ]; then
  echo "import '/app/apps/mcp/src/stations/xmtp/index.ts';" > "$METRO_TRAINS_DIR/xmtp.ts"
fi
if [ -n "$TELEGRAM_BOT_TOKENS" ]; then
  echo "import '/app/apps/mcp/src/stations/telegram/index.ts';" > "$METRO_TRAINS_DIR/telegram.ts"
fi
if [ -n "$DISCORD_BOT_TOKENS" ]; then
  echo "import '/app/apps/mcp/src/stations/discord/index.ts';" > "$METRO_TRAINS_DIR/discord.ts"
fi

exec bun /app/apps/mcp/src/server.ts
