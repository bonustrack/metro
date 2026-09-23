#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
T=${TMPDIR:-/tmp}
TMP=$(mktemp -d "${T%/}/metro-compat.XXXXXX")
OLD="$TMP/old"
PIDS=()
ORG=org_01COMPATCHECK0000
AGENT=cmpAgent001
ACCOUNT=cmpThreema1
export DYLD_FALLBACK_LIBRARY_PATH=/usr/lib

cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do
    kill "$p" 2>/dev/null || true
    wait "$p" 2>/dev/null || true
  done
  git -C "$ROOT" worktree remove --force "$OLD" 2>/dev/null || true
  git -C "$ROOT" worktree prune
  rm -rf "$TMP"
}
trap cleanup EXIT

published_ref() {
  local version=$1 c
  for c in $(git log -S"\"version\": \"$version\"" --format=%H -- packages/cli/package.json); do
    if git show "$c:packages/cli/package.json" | grep -q "\"version\": \"$version\""; then echo "$c"; fi
  done | tail -1
}

if [ -n "${COMPAT_REF:-}" ]; then
  REF=$COMPAT_REF
  echo "compat: against COMPAT_REF $REF"
else
  VERSION=$(npm view @stage-labs/metro dist-tags.beta)
  REF=$(published_ref "$VERSION")
  if [ -z "$REF" ]; then echo "compat: no commit sets packages/cli to $VERSION"; exit 1; fi
  echo "compat: against the published $VERSION at ${REF:0:9}"
fi

git worktree add --quiet --detach "$OLD" "$REF"
(cd "$OLD" && bun install --frozen-lockfile >"$TMP/install.log" 2>&1) || { cat "$TMP/install.log"; exit 1; }

BOX="$TMP/box"
mkdir -p "$BOX/bin" "$BOX/home" "$BOX/agents" "$BOX/state" "$BOX/trains" "$BOX/claude"
ln -s "$(command -v bun)" "$BOX/bin/bun"
ln -s "$(command -v node)" "$BOX/bin/node"
printf '%s\n' "$ORG" >"$BOX/agents/.owner"
cat >"$BOX/agents/agent.json" <<JSON
{
  "version": 1,
  "id": "$AGENT",
  "key": "mk_compatcompatcompatcompatcompat",
  "owner": "$ORG",
  "stations": [
    {
      "station": "threema",
      "id": "$ACCOUNT",
      "allowlist": ["*"],
      "config": {
        "gatewayId": "*COMPAT1",
        "secret": "compat",
        "privateKey": "$(printf '%064d' 1)",
        "callbackId": "1234567890123456789",
        "callbackToken": "compat",
        "createdAt": "2026-09-01T00:00:00.000Z"
      }
    }
  ],
  "connectors": []
}
JSON

bun scripts/compat/issuer.ts "$TMP/issuer.json" "$ORG" &
PIDS+=("$!")
for _ in $(seq 1 50); do [ -s "$TMP/issuer.json" ] && break; sleep 0.2; done
ISSUER=$(bun -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$TMP/issuer.json','utf8')).base)")
TOKEN=$(bun -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$TMP/issuer.json','utf8')).token)")

PORT=$((10000 + RANDOM % 20000))
(cd "$OLD" && exec env -i PATH="$BOX/bin" HOME="$BOX/home" DYLD_FALLBACK_LIBRARY_PATH=/usr/lib \
  METRO_AGENTS_DIR="$BOX/agents" METRO_STATE_DIR="$BOX/state" METRO_TRAINS_DIR="$BOX/trains" \
  METRO_CLAUDE_DIR="$BOX/claude" CLAUDE_CONFIG_DIR="$BOX/claude" \
  METRO_WEBHOOK_PORT="$PORT" METRO_HTTP_HOST=127.0.0.1 METRO_LOG_LEVEL=warn \
  WORKOS_API_BASE="$ISSUER" WORKOS_CLIENT_ID=client_test METRO_CLI_BIN=/nonexistent \
  bun apps/daemon/src/server.ts >"$TMP/daemon.log" 2>&1) &
PIDS+=("$!")
up=0
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/health"; then up=1; break; fi
  sleep 0.5
done
if [ "$up" = 0 ]; then echo "compat: the old daemon never answered /health; its log:"; cat "$TMP/daemon.log"; exit 1; fi

if COMPAT_HOST="127.0.0.1:$PORT" COMPAT_TOKEN="$TOKEN" COMPAT_ORG="$ORG" COMPAT_ACCOUNT="$ACCOUNT" COMPAT_AGENT="$AGENT" \
  bun scripts/compat/probe.ts; then
  exit 0
fi
echo "compat: the old daemon's log, last 40 lines:"
tail -40 "$TMP/daemon.log"
exit 1
