export const NODE_RE = /^metro-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
export const OWNER_RE = /^0x[0-9a-f]{40}$/;
export const AUTH_KEY_RE = /^tskey-auth-[A-Za-z0-9_-]{8,200}$/;
const TAG_RE = /^[a-z0-9][A-Za-z0-9.-]{0,40}$/;

export const SETUP_STEPS = ['packages', 'node', 'bun', 'claude', 'tailscale', 'metro', 'service'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

const step = (name: SetupStep): string => `echo "metro setup: step ${name}"`;

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

export function cloudInit(spec: BoxSpec): string {
  const hostname = check(spec.hostname, HOSTNAME_RE, 'The host name');
  const node = check(spec.node, NODE_RE, 'The tailnet name');
  const owner = check(spec.owner, OWNER_RE, 'The owner wallet');
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
    step('packages'),
    'apt-get -o DPkg::Lock::Timeout=600 update -y',
    'apt-get -o DPkg::Lock::Timeout=600 install -y curl ca-certificates git tmux unzip',
    step('node'),
    'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
    'apt-get -o DPkg::Lock::Timeout=600 install -y nodejs',
    step('bun'),
    'curl -fsSL https://bun.sh/install | bash',
    'ln -sf /root/.bun/bin/bun /usr/local/bin/bun',
    step('claude'),
    'curl -fsSL https://claude.ai/install.sh | bash',
    'ln -sf /root/.local/bin/claude /usr/local/bin/claude',
    step('tailscale'),
    'curl -fsSL https://tailscale.com/install.sh | sh',
    `tailscale up --auth-key='${key}' --hostname='${node}' --ssh`,
    step('metro'),
    `npm install -g '@stage-labs/metro@${tag}'`,
    'mkdir -p /root/.metro/agents && chmod 700 /root/.metro/agents',
    `printf '%s\\n' '${node}' > /root/.metro/agents/.node && chmod 600 /root/.metro/agents/.node`,
    step('service'),
    `metro service install --owner '${owner}'`,
    'echo "metro setup: done $(date -u +%FT%TZ)"',
    '',
  ].join('\n');
}
