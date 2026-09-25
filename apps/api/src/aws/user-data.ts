export const NODE_RE = /^metro-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
export const OWNER_RE = /^org_[A-Za-z0-9]{10,64}$/;
export const AUTH_KEY_RE = /^tskey-auth-[A-Za-z0-9_-]{8,200}$/;
const TAG_RE = /^[a-z0-9][A-Za-z0-9.-]{0,40}$/;

export const SETUP_STEPS = ['packages', 'node', 'bun', 'user', 'tailscale', 'metro', 'service'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

const step = (name: SetupStep): string => `echo "metro setup: step ${name}"`;

const METRO_HOME = '/var/lib/metro';
const PREFIX = `${METRO_HOME}/.npm-global`;
const AGENTS = `${METRO_HOME}/.metro/agents`;

export interface BoxSpec {
  hostname: string;
  node: string;
  owner: string;
  tailscaleAuthKey: string;
  metroTag: string;
}

function check(value: string, re: RegExp, what: string): string {
  if (!re.test(value)) throw new Error(`${what} does not look right: ${value === '' ? 'it is empty' : 'it holds a character the script cannot carry'}.`);
  return value;
}

function checkAuthKey(value: string): string {
  if (AUTH_KEY_RE.test(value)) return value;
  if (value === '') throw new Error('The Tailscale auth key is required.');
  throw new Error(
    'The Tailscale auth key does not look right: an auth key starts with tskey-auth-. An API access token (tskey-api-) or a client secret cannot join a machine; generate an auth key under Settings, Keys in the Tailscale admin console.',
  );
}

const TOOLS = [
  step('packages'),
  'apt-get -o DPkg::Lock::Timeout=600 update -y',
  'apt-get -o DPkg::Lock::Timeout=600 install -y curl ca-certificates git tmux unzip sudo iptables',
  step('node'),
  'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
  'apt-get -o DPkg::Lock::Timeout=600 install -y nodejs',
  step('bun'),
  'curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash',
  step('user'),
  `useradd --system --create-home --home-dir ${METRO_HOME} --shell /usr/sbin/nologin --groups systemd-journal metro`,
  `chmod 711 ${METRO_HOME}`,
];

const metroSteps = (node: string, owner: string, tag: string): string[] => [
  step('metro'),
  `sudo -u metro -H sh -c "cd / && npm install --global --prefix ${PREFIX} '@stage-labs/metro@${tag}'"`,
  `install -d -o metro -g metro -m 700 ${METRO_HOME}/.metro ${AGENTS}`,
  `printf '%s\\n' '${node}' > ${AGENTS}/.node && chown metro:metro ${AGENTS}/.node && chmod 600 ${AGENTS}/.node`,
  step('service'),
  `${PREFIX}/bin/metro service install --owner '${owner}' --user metro`,
];

export function cloudInit(spec: BoxSpec): string {
  const hostname = check(spec.hostname, HOSTNAME_RE, 'The host name');
  const node = check(spec.node, NODE_RE, 'The tailnet name');
  const owner = check(spec.owner, OWNER_RE, 'The owner');
  const key = checkAuthKey(spec.tailscaleAuthKey);
  const tag = check(spec.metroTag, TAG_RE, 'The metro version');
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'export HOME=/root DEBIAN_FRONTEND=noninteractive',
    'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'exec > >(tee -a /var/log/metro-setup.log) 2>&1',
    'echo "metro setup: start $(date -u +%FT%TZ)"',
    `hostnamectl set-hostname '${hostname}'`,
    ...TOOLS,
    step('tailscale'),
    'curl -fsSL https://tailscale.com/install.sh | sh',
    `tailscale up --auth-key='${key}' --hostname='${node}' --ssh --operator=metro`,
    ...metroSteps(node, owner, tag),
    'echo "metro setup: done $(date -u +%FT%TZ)"',
    '',
  ].join('\n');
}
