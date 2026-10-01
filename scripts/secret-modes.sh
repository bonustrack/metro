#!/usr/bin/env bash
set -uo pipefail
METRO_HOME=${METRO_HOME:-/var/lib/metro}
AGENT_HOME=${AGENT_HOME:-/home/agent}
METRO_USER=${METRO_USER:-metro}
AGENT_USER=${AGENT_USER:-agent}
SHARED=.npm-global
KNOWN=(.metro .cache .npm .bun .config .local .ssh .gnupg .pki .profile .bashrc .bash_logout .bash_history)
fails=0

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=1; }
owner_mode() { stat -c '%U %a' "$1" 2>/dev/null; }

expect_exact() {
  local path=$1 owner=$2 mode=$3 got
  got=$(owner_mode "$path") || { fail "$path is missing or cannot be read by $(id -un)"; return; }
  [ "$got" = "$owner $mode" ] && pass "$path is $owner $mode" || fail "$path is $got, expected $owner $mode"
}

expect_closed() {
  local path=$1 got
  got=$(owner_mode "$path") || return
  local mode=${got#* }
  [ "${got%% *}" = "$METRO_USER" ] && [ $((8#$mode & 8#077)) -eq 0 ] && pass "$path is closed ($got)" || fail "$path is open to other users ($got)"
}

metro_entries() {
  if ls -A "$METRO_HOME" >/dev/null 2>&1; then ls -A "$METRO_HOME"; else printf '%s\n' "${KNOWN[@]}"; fi
}

expect_exact "$METRO_HOME" "$METRO_USER" 711
expect_exact "$METRO_HOME/.metro" "$METRO_USER" 700
while IFS= read -r name; do
  [ "$name" = "$SHARED" ] && continue
  [ -L "$METRO_HOME/$name" ] && continue
  expect_closed "$METRO_HOME/$name"
done < <(metro_entries)
writable=$(find "$METRO_HOME/$SHARED" ! -type l -perm -o+w 2>/dev/null | head -n 3)
[ -z "$writable" ] && pass "nothing in $METRO_HOME/$SHARED is writable by other users" || fail "writable by other users: $writable"
for f in "$AGENT_HOME"/.metro/agents/*; do
  [ -e "$f" ] || continue
  expect_exact "$f" "$AGENT_USER" 600
done
for f in /usr/local/lib/metro/root-helper /etc/systemd/system/metro.service; do
  got=$(owner_mode "$f") || continue
  mode=${got#* }
  [ "${got%% *}" = root ] && [ $((8#$mode & 8#022)) -eq 0 ] && pass "$f is root's and not writable by others ($got)" || fail "$f is $got"
done
if [ "$(id -un)" = "$AGENT_USER" ]; then
  ! ls "$METRO_HOME" >/dev/null 2>&1 && pass "the agent cannot list $METRO_HOME" || fail "the agent can list $METRO_HOME"
  ! ls "$METRO_HOME/.metro" >/dev/null 2>&1 && pass "the agent cannot list $METRO_HOME/.metro" || fail "the agent can list $METRO_HOME/.metro"
  for name in "${KNOWN[@]}"; do
    [ -e "$METRO_HOME/$name" ] || continue
    [ ! -r "$METRO_HOME/$name" ] && pass "the agent cannot read $METRO_HOME/$name" || fail "the agent can read $METRO_HOME/$name"
  done
fi
exit "$fails"
