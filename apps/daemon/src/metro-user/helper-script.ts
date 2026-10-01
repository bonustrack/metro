const ROOT_DIR = '/usr/local/lib/metro';
export const HELPER_PATH = `${ROOT_DIR}/root-helper`;
const HELPER_VERSION = 3;
export const SUDOERS_PATH = '/etc/sudoers.d/metro';
export const IMDS_UNIT = 'metro-imds.service';
export const IMDS_UNIT_PATH = `/etc/systemd/system/${IMDS_UNIT}`;
export const UPGRADE_UNIT = 'metro-root-upgrade@.service';
export const UPGRADE_UNIT_PATH = `/etc/systemd/system/${UPGRADE_UNIT}`;
const RELEASE_DIR = `${ROOT_DIR}/release`;
export const METRO_USER = 'metro';
const METRO_HOME = '/var/lib/metro';
const VAULT_DROP_IN = '11-metro-vault.conf';
const PRIVILEGED_EXEC = ['ExecConditionEx', 'ExecStartPreEx', 'ExecStartEx', 'ExecStartPostEx', 'ExecReloadEx', 'ExecStopEx', 'ExecStopPostEx'];

export const sudoersText = (agent: string): string =>
  [
    `${METRO_USER} ALL=(${agent}) NOPASSWD: ALL`,
    `${METRO_USER} ALL=(root) NOPASSWD: ${HELPER_PATH} *`,
    `Defaults:${METRO_USER} !requiretty`,
    '',
  ].join('\n');

const lines = (...parts: string[]): string => parts.join('\n');

const CHECKS = lines(
  'AGENT=agent',
  'UNITS=/etc/systemd/system',
  'die() { echo "root-helper: $*" >&2; exit 2; }',
  'agent_uid() { id -u "$AGENT" 2>/dev/null || die "no agent user"; }',
  'service_ok() {',
  '  case "$1" in [!A-Za-z0-9]*|*[!A-Za-z0-9@_.-]*|"") die "bad service name";; esac',
  '  case "$1" in *.service) ;; *) die "bad service name";; esac',
  '  case "$1" in metro*) die "not a metro unit";; esac',
  '  frag=$(systemctl show "$1" -p FragmentPath --value)',
  '  case "$frag" in "$UNITS"/*) ;; *) die "not a unit under $UNITS";; esac',
  '  systemctl show "$1" -p TriggeredBy --value | grep -q "\\.timer" || die "not started by a timer"',
  '}',
  'agent_only() {',
  '  [ "$(systemctl show "$1" -p User --value)" = "$AGENT" ] || die "that job does not run as $AGENT"',
  '  [ "$(systemctl show "$1" -p PermissionsStartOnly --value)" != yes ] || die "that job runs commands as root"',
  '  [ -n "$(systemctl show "$1" -p ExecStartEx --value)" ] || die "cannot read the commands of that job"',
  `  if systemctl show "$1" ${PRIVILEGED_EXEC.map((p) => `-p ${p}`).join(' ')} --value | grep -Eq "flags=[^;]*(privileged|no-setuid|ambient)"; then die "that job runs commands as root"; fi`,
  '}',
  'dropin_ok() {',
  `  [ "$1" = ${VAULT_DROP_IN} ] || die "bad drop-in name"`,
  '  home=$(getent passwd "$AGENT" | cut -d: -f6)',
  '  printf \'[Service]\\nEnvironmentFile=-%s/.metro/vault.env\\n\' "$home" | cmp -s - "$2" || die "only the vault environment file may be added"',
  '}',
);

const FIREWALL = lines(
  'firewall_on() {',
  '  uid=$(agent_uid)',
  '  for t in iptables ip6tables; do',
  '    $t -w -N METRO_AGENT 2>/dev/null || true',
  '    $t -w -F METRO_AGENT',
  '    $t -w -A METRO_AGENT -o lo -j ACCEPT',
  '    $t -w -A METRO_AGENT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
  '    $t -w -A METRO_AGENT -p udp --dport 53 -j ACCEPT',
  '    $t -w -A METRO_AGENT -p tcp --dport 53 -j ACCEPT',
  '    $t -w -A METRO_AGENT -p tcp -j REJECT --reject-with tcp-reset',
  '    $t -w -A METRO_AGENT -j REJECT',
  '    $t -w -C OUTPUT -m owner --uid-owner "$uid" -j METRO_AGENT 2>/dev/null || $t -w -I OUTPUT -m owner --uid-owner "$uid" -j METRO_AGENT',
  '  done',
  '}',
  'firewall_off() {',
  '  uid=$(agent_uid)',
  '  for t in iptables ip6tables; do',
  '    while $t -w -C OUTPUT -m owner --uid-owner "$uid" -j METRO_AGENT 2>/dev/null; do $t -w -D OUTPUT -m owner --uid-owner "$uid" -j METRO_AGENT; done',
  '    $t -w -F METRO_AGENT 2>/dev/null || true',
  '    $t -w -X METRO_AGENT 2>/dev/null || true',
  '  done',
  '}',
);

const IMDS = lines(
  'imds_block() {',
  `  metro_uid=$(id -u ${METRO_USER} 2>/dev/null) || die "no ${METRO_USER} user"`,
  '  for t in iptables ip6tables; do',
  '    if [ "$t" = iptables ]; then dst=169.254.169.254; else dst=fd00:ec2::254; fi',
  '    if ! $t -w -L OUTPUT -n >/dev/null 2>&1; then [ "$t" = ip6tables ] && continue; die "$t is not usable"; fi',
  '    $t -w -N METRO_IMDS 2>/dev/null || true',
  '    $t -w -F METRO_IMDS',
  '    $t -w -A METRO_IMDS -m owner --uid-owner 0 -j RETURN',
  '    $t -w -A METRO_IMDS -m owner --uid-owner "$metro_uid" -j RETURN',
  '    $t -w -A METRO_IMDS -p tcp -j REJECT --reject-with tcp-reset',
  '    $t -w -A METRO_IMDS -j REJECT',
  '    $t -w -C OUTPUT -d "$dst" -j METRO_IMDS 2>/dev/null || $t -w -I OUTPUT -d "$dst" -j METRO_IMDS',
  '  done',
  '}',
);

export const imdsUnitText = (): string =>
  lines(
    '[Unit]',
    `Description=Metro: only root and ${METRO_USER} reach the instance metadata service`,
    'DefaultDependencies=no',
    'After=local-fs.target',
    'Before=network-pre.target shutdown.target',
    'Wants=network-pre.target',
    'Conflicts=shutdown.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=${HELPER_PATH} imds-block`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  );

export const upgradeUnitText = (node: string): string =>
  lines(
    '[Unit]',
    'Description=Metro: bring the root side to Metro %i, checked against npm and its GitHub provenance',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=/usr/bin/flock ${ROOT_DIR} ${node} ${RELEASE_DIR}/dist/cli.js service root-upgrade %i`,
    'TimeoutStartSec=900',
    '',
  );

const ACTIONS = lines(
  'action="${1:-}"; [ "$#" -gt 0 ] && shift',
  'case "$action" in',
  `  version) echo ${String(HELPER_VERSION)} ;;`,
  '  ensure-agent)',
  '    getent passwd "$AGENT" >/dev/null || useradd --create-home --shell /bin/bash "$AGENT"',
  '    chmod 700 "$(getent passwd "$AGENT" | cut -d: -f6)" ;;',
  '  as-agent-scope)',
  '    [ "$#" -ge 3 ] || die "usage: as-agent-scope <max> <high> <command...>"',
  '    printf %s "$1$2" | grep -Eq "^[0-9]+$" || die "bad memory limits"',
  '    max="$1"; high="$2"; shift 2',
  '    uid=$(agent_uid); gid=$(id -g "$AGENT")',
  '    exec systemd-run --scope --quiet --collect --unit="metro-claude-$(date +%s%N)" -p MemoryMax="$max" -p MemoryHigh="$high" -p OOMPolicy=continue -- setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@" ;;',
  '  dropin-write)',
  '    service_ok "$1"; agent_only "$1"; tmp=$(mktemp); trap \'rm -f "$tmp"\' EXIT; head -c 4096 > "$tmp"; dropin_ok "$2" "$tmp"',
  '    mkdir -p "$UNITS/$1.d"; install -m 644 "$tmp" "$UNITS/$1.d/$2" ;;',
  '  dropin-remove)',
  `    service_ok "$1"; [ "$2" = ${VAULT_DROP_IN} ] || die "bad drop-in name"`,
  '    rm -f "$UNITS/$1.d/$2" ;;',
  '  daemon-reload) systemctl daemon-reload ;;',
  '  start-job)',
  '    service_ok "$1"; [ "$(systemctl show "$1" -p User --value)" = "$AGENT" ] || die "that job does not run as $AGENT"',
  '    systemctl start --no-block "$1" ;;',
  '  root-crontab) crontab -l -u root 2>/dev/null || true ;;',
  '  root-crontab-drop)',
  '    printf %s "$1" | grep -Eq "^[0-9a-f]{16}$" || die "bad line id"',
  `    backups="${METRO_HOME}/.metro/agents"`,
  '    cur=$(mktemp); crontab -l -u root > "$cur" 2>/dev/null || true',
  '    kept=$(mktemp); found=0',
  '    while IFS= read -r line; do',
  '      id=$(printf %s "$line" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//" | tr -d "\\n" | sha256sum | cut -c1-16)',
  '      if [ "$id" = "$1" ] && [ "$found" = 0 ]; then found=1; elif [ -n "$line" ]; then printf "%s\\n" "$line" >> "$kept"; fi',
  '    done < "$cur"',
  '    [ "$found" = 1 ] || die "that cron line is gone"',
  '    install -m 600 "$cur" "$backups/crontab-root.$(date +%Y-%m-%dT%H-%M-%S).bak"',
  '    crontab -u root "$kept"; rm -f "$cur" "$kept" ;;',
  '  imds-block) imds_block ;;',
  '  upgrade)',
  '    [ "$#" -eq 1 ] || die "usage: upgrade <version>"',
  '    case "$1" in *[!0-9A-Za-z.-]*|"") die "bad version";; esac',
  '    printf %s "$1" | grep -Eqx "[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}(-[0-9A-Za-z]{1,20}(\\.[0-9A-Za-z]{1,20}){0,4})?" || die "bad version"',
  `    systemctl start --no-block "${UPGRADE_UNIT.replace('@.', '@$1.')}" ;;`,
  '  firewall-on) firewall_on ;;',
  '  firewall-off) firewall_off ;;',
  '  trust-ca)',
  `    src="${METRO_HOME}/.metro/agents/vault/ca/ca.crt"`,
  '    head -n1 "$src" | grep -q "BEGIN CERTIFICATE" || die "not a certificate"',
  '    if grep -q "PRIVATE KEY" "$src"; then die "a key is not a certificate"; fi',
  '    install -m 644 "$src" /usr/local/share/ca-certificates/metro-vault.crt && update-ca-certificates >/dev/null ;;',
  '  untrust-ca) rm -f /usr/local/share/ca-certificates/metro-vault.crt; update-ca-certificates --fresh >/dev/null ;;',
  '  install-nss-tools) DEBIAN_FRONTEND=noninteractive apt-get install -y -q libnss3-tools >/dev/null ;;',
  '  *) die "unknown action: $action" ;;',
  'esac',
);

export const helperScript = (): string =>
  ['#!/bin/sh', 'set -eu', 'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', CHECKS, FIREWALL, IMDS, ACTIONS, ''].join('\n');
