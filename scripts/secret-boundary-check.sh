#!/bin/bash
# Run on a box as the agent user: sudo -u agent bash secret-boundary-check.sh
# Every check prints PASS or FAIL and a path or a name, never a value.
set -uo pipefail

METRO_HOME=${METRO_HOME:-/var/lib/metro}
PORT=${METRO_WEBHOOK_PORT:-8420}
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=1; }

if [ "$(id -un)" != agent ]; then
  echo "run this as the agent user (now: $(id -un))" >&2
  exit 2
fi

if bash "$(dirname "$0")/secret-modes.sh"; then pass "secret-modes: Metro's home and view files have the right modes"; else fail "secret-modes found an open mode (see above)"; fi
for entry in .metro/agents/agent.json .metro/agents/model.json .metro/agents/connectors.json .metro/agents/voice.json \
  .cache/metro/serve/telegram .bun .npm .npmrc .codex .claude.json .aws .ssh; do
  path="$METRO_HOME/$entry"
  if [ -d "$path" ] && ls "$path" >/dev/null 2>&1; then fail "metro folder listable by the agent: $path"
  elif [ -f "$path" ] && head -c1 "$path" >/dev/null 2>&1; then fail "metro file readable by the agent: $path"
  fi
done

for f in /var/lib/tailscale/tailscaled.state /var/lib/cloud/instance/user-data.txt /etc/ssh/ssh_host_ed25519_key /etc/shadow /etc/sudoers.d/metro; do
  if head -c1 "$f" >/dev/null 2>&1; then fail "readable by the agent: $f"; else pass "not readable: $f"; fi
done

proc_open=0
for pid in $(ps -eo pid=,user= | awk '$2!="agent"{print $1}'); do
  for part in environ mem; do
    if head -c1 "/proc/$pid/$part" >/dev/null 2>&1; then fail "/proc/$pid/$part readable ($(ps -o comm= -p "$pid"))"; proc_open=1; fi
  done
  if ls "/proc/$pid/fd" >/dev/null 2>&1; then fail "/proc/$pid/fd listable ($(ps -o comm= -p "$pid"))"; proc_open=1; fi
done
[ "$proc_open" = 0 ] && pass "/proc: no environ, memory or open file of another user's process is readable"

scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)
if [ "$scope" -ge 1 ]; then pass "kernel.yama.ptrace_scope is $scope"; else fail "kernel.yama.ptrace_scope is $scope"; fi

if sudo -n true >/dev/null 2>&1; then fail "the agent can sudo without a password"; else pass "the agent has no sudo"; fi

metro_uid=$(id -u metro 2>/dev/null || echo 999)
if [ -n "$(journalctl "_UID=$metro_uid" -n 1 -q --no-pager 2>/dev/null)" ]; then fail "the agent can read metro's journal"; else pass "metro's journal is closed to the agent"; fi

argv_hits=$(ps -eo user=,args= | awk '$1!="agent"' | grep -E -i -c 'tskey-[a-z]+-|sk-ant-|sk-or-v1-|mk_[A-Za-z0-9_-]{20}|xoxb-|ghp_|GOCSPX-|--(token|secret|password|api-key)[= ]')
if [ "$argv_hits" = 0 ]; then pass "argv: no process of another user carries a secret-looking argument"; else fail "argv: $argv_hits processes of other users carry a secret-looking argument"; fi

if python3 - <<'EOF'
import json, subprocess, sys
try:
    out = subprocess.run(['tailscale', 'debug', 'prefs'], capture_output=True, text=True, timeout=10).stdout
    cfg = json.loads(out).get('Config', {})
except Exception:
    sys.exit(0)
for name in ('PrivateNodeKey', 'OldPrivateNodeKey', 'NetworkLockKey'):
    value = cfg.get(name, '')
    hexpart = value.split(':', 1)[1] if ':' in value else value
    if hexpart and set(hexpart) - {'0'}:
        print(f'FAIL tailscale LocalAPI gives the agent {name}')
        sys.exit(1)
EOF
then pass "tailscale LocalAPI hands the agent no node key"; else fails=1; fi

if tailscale cert --cert-file /dev/null --key-file /dev/null "$(hostname)" >/dev/null 2>&1; then fail "tailscale cert gives the agent the TLS key"; else pass "tailscale cert is refused for the agent"; fi

key=$(python3 -c "import json;print(json.load(open('$HOME/.metro/agents/agent.json'))['key'])" 2>/dev/null || true)
api() { curl -s -o /dev/null -w '%{http_code}' -m 10 "$@"; }
for p in /api/agents /api/model /api/connectors /api/voice /api/vault /api/claude/setup /api/server /api/files; do
  code=$(api -H "Authorization: Bearer $key" "http://127.0.0.1:$PORT$p")
  if [ "$code" = 401 ] || [ "$code" = 403 ] || [ "$code" = 404 ] || [ "$code" = 405 ]; then pass "admin api $p refuses the agent key ($code)"; else fail "admin api $p answers the agent key ($code)"; fi
done

host=$(tailscale status --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null || true)
if [ -n "$host" ] && [ -n "$key" ]; then
  local_code=$(api -H "x-metro-key: $key" "http://127.0.0.1:$PORT/gateway/v1/models")
  public_code=$(api -H "x-metro-key: $key" "https://$host/gateway/v1/models")
  mcp_code=$(api -X POST -H "Authorization: Bearer $key" -H 'content-type: application/json' --data '{}' "https://$host/mcp")
  [ "$local_code" = 200 ] && pass "the agent key works on this machine" || fail "the agent key does not work on this machine ($local_code)"
  if [ "$public_code" = 401 ] && [ "$mcp_code" = 401 ]; then pass "the agent key is refused through the public address"; else fail "the agent key works through the public address (gateway $public_code, mcp $mcp_code)"; fi
fi

imds=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -X PUT -H 'x-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
if [ "$imds" = 200 ]; then fail "the agent reaches the EC2 instance metadata (user data, role credentials)"; else pass "EC2 instance metadata is closed to the agent ($imds)"; fi

if python3 - <<'EOF'
import os, re, stat, sys
pats = {
    'tailscale auth key': rb'tskey-(auth|client|api)-[A-Za-z0-9]{6,}',
    'private key': rb'-----BEGIN [A-Z ]*PRIVATE KEY-----',
    'anthropic key': rb'sk-ant-[A-Za-z0-9_-]{20,}',
    'openrouter key': rb'sk-or-v1-[A-Za-z0-9]{32,}',
    'metro agent key': rb'mk_[A-Za-z0-9_-]{20,}',
    'aws key id': rb'\b(AKIA|ASIA)[A-Z0-9]{16}\b',
    'refresh token': rb'"refresh_?[Tt]oken"\s*:\s*"[^"]{20,}',
    'telegram bot token': rb'\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}',
}
me = os.getuid()
skip = ('/proc', '/sys', '/dev', '/snap', '/usr/share', '/usr/lib', '/usr/include', '/usr/src', '/var/lib/apt', '/var/cache/apt')
found = False
for top in ('/etc', '/var', '/opt', '/usr/local', '/run', '/tmp', '/srv', '/root', '/var/lib/metro'):
    for dp, dns, fns in os.walk(top, onerror=lambda e: None):
        if dp.startswith(skip):
            dns[:] = []
            continue
        dns[:] = [d for d in dns if d not in ('node_modules', '.git')]
        for fn in fns:
            p = os.path.join(dp, fn)
            try:
                st = os.lstat(p)
                if not stat.S_ISREG(st.st_mode) or st.st_uid == me or st.st_size > 4_000_000:
                    continue
                data = open(p, 'rb').read()
            except Exception:
                continue
            for name, rx in pats.items():
                if re.search(rx, data):
                    print(f'FAIL {name} pattern in a file of another user the agent can read: {p}')
                    found = True
sys.exit(1 if found else 0)
EOF
then pass "no secret pattern in any file of another user the agent can read"; else fails=1; fi

exit "$fails"
