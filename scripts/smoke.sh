#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
T=${TMPDIR:-/tmp}
TMP=$(mktemp -d "${T%/}/metro-smoke.XXXXXX")
PIDS=()
FAILED=0
export DYLD_FALLBACK_LIBRARY_PATH=/usr/lib

cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do
    kill "$p" 2>/dev/null || true
    wait "$p" 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

port() { echo $((10000 + RANDOM % 20000)); }

wait_health() {
  for _ in $(seq 1 80); do
    curl -sf -o /dev/null "http://127.0.0.1:$1/health" && return 0
    sleep 0.5
  done
  echo "  FAIL no /health on :$1 after 40s; the log:"
  cat "$2"
  return 1
}

expect() {
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' -X "$1" "http://127.0.0.1:$2$3")
  if [ "$got" = "$4" ]; then echo "  ok   $1 $3 -> $got"; else echo "  FAIL $1 $3 -> $got, wanted $4"; FAILED=1; fi
}

expect_body() {
  local got
  got=$(curl -s "http://127.0.0.1:$1$2")
  if [[ "$got" == *"$3"* ]]; then echo "  ok   GET $2 says $3"; else echo "  FAIL GET $2 -> $got"; FAILED=1; fi
}

hosted_checks() {
  expect_body "$1" /api/mode '"mode":"hosted"'
  expect GET "$1" /api/vault 401
  expect GET "$1" /api/servers 401
  expect GET "$1" /api/agents 404
  expect GET "$1" /mcp 404
}

echo "1. the runtime store, the path a box takes"
node packages/cli/scripts/stage-runtime.mjs
mkdir -p "$TMP/agents" "$TMP/state" "$TMP/store"
cat > "$TMP/prepare.ts" <<TS
import { prepareRuntime } from '$ROOT/packages/cli/src/runtime-install.ts';
const r = prepareRuntime({
  sources: '$ROOT/packages/cli/runtime',
  store: '$TMP/store',
  agents: '$TMP/agents',
  log: (line) => process.stderr.write(line + '\n'),
});
process.stdout.write(r.entry);
TS
ENTRY=$(bun "$TMP/prepare.ts")
echo "   store entry: ${ENTRY#"$TMP/"} ($(ls "$TMP/store/node_modules" | wc -l | tr -d ' ') top-level packages)"
P1=$(port)
METRO_STATE_DIR="$TMP/state" METRO_AGENTS_DIR="$TMP/agents" METRO_TRAINS_DIR="$TMP/store/trains" \
  METRO_RUNTIME_STORE="$TMP/store" METRO_RUNTIME_MANIFEST="$ROOT/packages/cli/runtime/stations.json" \
  METRO_WEBHOOK_PORT="$P1" METRO_HTTP_HOST=127.0.0.1 METRO_LOG_LEVEL=warn \
  bun --no-install "$ENTRY" >"$TMP/daemon.log" 2>&1 &
PIDS+=("$!")
wait_health "$P1" "$TMP/daemon.log"
expect_body "$P1" /api/mode '"mode":"local"'
expect HEAD "$P1" /gateway/api/hello 200
expect GET "$P1" /mcp 401
expect GET "$P1" /api/agents 401
expect GET "$P1" /api/vault 404

echo "2. api.metro.box alone, with no database"
P2=$(port)
env -u DATABASE_URL METRO_WEBHOOK_PORT="$P2" METRO_HTTP_HOST=127.0.0.1 METRO_LOG_LEVEL=warn \
  bun --no-install apps/api/src/server.ts >"$TMP/api.log" 2>&1 &
PIDS+=("$!")
wait_health "$P2" "$TMP/api.log"
hosted_checks "$P2"

echo "3. the filtered image install, as the Dockerfile does it"
IMG="$TMP/image"
mkdir -p "$IMG"
cp package.json bun.lock turbo.json "$IMG/"
for m in apps/*/package.json packages/*/package.json; do
  mkdir -p "$IMG/$(dirname "$m")"
  cp "$m" "$IMG/$m"
done
(cd "$IMG" && bun install --frozen-lockfile --production --filter @metro-labs/api >"$TMP/install.log" 2>&1) || { cat "$TMP/install.log"; exit 1; }
for d in apps/api packages/core packages/http; do
  (cd "$d" && tar --exclude=node_modules -cf - .) | (cd "$IMG/$d" && tar -xf -)
done
echo "   $(ls "$IMG/node_modules/.bun/node_modules" | wc -l | tr -d ' ') packages in the image, isolated under node_modules/.bun, $(du -sh "$IMG/node_modules" | cut -f1) on disk"
P3=$(port)
(cd "$IMG" && exec env -u DATABASE_URL METRO_WEBHOOK_PORT="$P3" METRO_HTTP_HOST=127.0.0.1 METRO_LOG_LEVEL=warn \
  bun --no-install apps/api/src/server.ts >"$TMP/image.log" 2>&1) &
PIDS+=("$!")
wait_health "$P3" "$TMP/image.log"
hosted_checks "$P3"

if [ "$FAILED" = 0 ]; then echo "smoke: all three passed"; else echo "smoke: FAILED"; exit 1; fi
