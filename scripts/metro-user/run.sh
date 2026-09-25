#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
name=metro-user-check
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
(cd "$root/packages/cli" && bun run build >/dev/null && npm pack --pack-destination "$work" >/dev/null 2>&1)
mv "$work"/*.tgz "$work/metro.tgz"
docker run -d --rm --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v "$root:/repo:ro" -v "$work:/pkg:ro" ubuntu:24.04 bash /repo/scripts/metro-user/boot.sh >/dev/null
for _ in $(seq 1 120); do docker exec "$name" test -f /ready 2>/dev/null && break; sleep 5; done
docker exec "$name" bash /repo/scripts/metro-user/setup-root.sh | tail -2
move() {
  docker exec "$name" sh -c "cd /repo/apps/daemon && bun -e 'import { startMove } from \"./src/metro-user/move.ts\"; startMove(\"$1\")'" >/dev/null
  for _ in $(seq 1 120); do s=$(docker exec "$name" cat /var/lib/metro-move/state 2>/dev/null || true); case "$s" in done|failed) break;; esac; sleep 3; done
  echo "$s"
}
runs_as() { docker exec "$name" sh -c 'ps -o user= -p "$(systemctl show metro -p MainPID --value)"'; }
healthy() { docker exec "$name" curl -fsS -m 5 http://127.0.0.1:8420/health >/dev/null; }
fails=0
report() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=1; fi; }
[ "$(move left-pad@1.3.0)" = failed ] && [ "$(runs_as)" = root ] && healthy && docker exec "$name" test -d /root/.metro && r=ok || r=no
report "a move that cannot start as metro puts everything back as root" "$r"
[ "$(move /pkg/metro.tgz)" = done ] && [ "$(runs_as)" = metro ] && healthy && docker exec "$name" test -d /var/lib/metro/.metro && ! docker exec "$name" test -e /root/.metro && r=ok || r=no
report "the move runs Metro as the metro user, healthy, with its files moved" "$r"
docker exec "$name" bash /repo/scripts/metro-user/fixtures-root.sh >/dev/null
checks=$(docker exec -u metro -e HOME=/var/lib/metro -w / "$name" sh -c 'cd /repo/apps/daemon && bun /repo/scripts/metro-user/as-metro.ts' 2>&1 || true)
echo "$checks" | grep -E '^(PASS|FAIL)'
if echo "$checks" | grep -q '^FAIL' || ! echo "$checks" | grep -q '^PASS'; then fails=1; fi
exit "$fails"
