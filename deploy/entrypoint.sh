#!/usr/bin/env bash
# Cloud entrypoint: boot the Metro daemon (supervisor + trains + HTTP/SSE API)
# and the Streamable-HTTP MCP server in one container. All config via env; no
# secrets on disk (mnemonic + bot tokens come from env — see deploy/README.md).
#
# Processes:
#   1. metro daemon  — packages/metro/src/server.ts (dispatcher boot)
#                      serves the webhook + monitor HTTP API on METRO_WEBHOOK_PORT
#                      (default 8420), and supervises the trains in METRO_TRAINS_DIR.
#   2. metro-channel — the MCP server in HTTP mode (METRO_MCP_TRANSPORT=http),
#                      bridging to the daemon over METRO_BASE_URL.
set -euo pipefail

cd /app

# Trains: cloud trains live in deploy/trains (re-export the station code).
export METRO_TRAINS_DIR="${METRO_TRAINS_DIR:-/app/deploy/trains}"
# Persistent state (XMTP MLS dbs, outbox, history) on a mounted volume.
export METRO_STATE_DIR="${METRO_STATE_DIR:-/data/cache}"
mkdir -p "$METRO_STATE_DIR"

# MCP server defaults: HTTP transport, talk to the local daemon API.
export METRO_MCP_TRANSPORT="${METRO_MCP_TRANSPORT:-http}"
export METRO_MCP_HTTP_PORT="${METRO_MCP_HTTP_PORT:-8421}"
export METRO_BASE_URL="${METRO_BASE_URL:-http://127.0.0.1:${METRO_WEBHOOK_PORT:-8420}}"
# The daemon monitor API only answers on an allowlisted Host; allow the loopback
# base the MCP bridge uses (override METRO_MONITOR_HOSTS for other ingress).
export METRO_MONITOR_HOSTS="${METRO_MONITOR_HOSTS:-127.0.0.1,localhost}"

term() { echo "entrypoint: shutting down"; kill -TERM "${DAEMON_PID:-}" "${MCP_PID:-}" 2>/dev/null || true; }
trap term TERM INT

echo "entrypoint: starting metro daemon (trains=$METRO_TRAINS_DIR state=$METRO_STATE_DIR)"
bun /app/packages/metro/src/server.ts &
DAEMON_PID=$!

# Give the daemon a moment to bind its HTTP API before the MCP bridge subscribes.
sleep 2

echo "entrypoint: starting metro-channel MCP (http :$METRO_MCP_HTTP_PORT -> $METRO_BASE_URL)"
bun /app/packages/metro/src/mcp/index.ts &
MCP_PID=$!

# Exit if either process dies (let the orchestrator restart the container).
wait -n "$DAEMON_PID" "$MCP_PID"
echo "entrypoint: a process exited; tearing down"
term
wait || true
