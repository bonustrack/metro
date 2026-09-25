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
docker exec "$name" bash /repo/scripts/metro-user/install.sh | tail -2
runs_as() { docker exec "$name" sh -c 'ps -o user= -p "$(systemctl show metro -p MainPID --value)"'; }
healthy() { docker exec "$name" curl -fsS -m 5 http://127.0.0.1:8420/health >/dev/null; }
fails=0
report() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=1; fi; }
[ "$(runs_as)" = metro ] && healthy && docker exec "$name" test -d /var/lib/metro/.metro/agents && ! docker exec "$name" test -e /root/.metro && r=ok || r=no
report "a fresh install runs Metro as the metro user, healthy, with nothing under /root" "$r"
[ "$(docker exec "$name" systemctl show metro -p User --value)" = metro ] && [ "$(docker exec "$name" systemctl show metro -p OOMPolicy --value)" = continue ] && r=ok || r=no
report "the unit names the metro user and keeps running when one process is killed" "$r"
[ "$(docker exec -u metro "$name" sudo -n /usr/local/lib/metro/root-helper version)" = 1 ] && [ "$(docker exec "$name" stat -c %a /etc/sudoers.d/metro)" = 440 ] && r=ok || r=no
report "the install wrote the root helper and the checked sudo rules" "$r"
for _ in $(seq 1 120); do docker exec "$name" test -x /home/agent/.local/bin/claude 2>/dev/null && break; sleep 5; done
docker exec "$name" id agent >/dev/null 2>&1 && r=ok || r=no
report "Metro created the agent user and installed Claude Code for it" "$r"
docker exec "$name" bash /repo/scripts/metro-user/fixtures.sh >/dev/null
checks=$(docker exec -u metro -e HOME=/var/lib/metro -w / "$name" sh -c 'cd /repo/apps/daemon && bun /repo/scripts/metro-user/as-metro.ts' 2>&1 || true)
echo "$checks" | grep -E '^(PASS|FAIL)'
if echo "$checks" | grep -q '^FAIL' || ! echo "$checks" | grep -q '^PASS'; then fails=1; fi
exit "$fails"
