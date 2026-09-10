export const NODE_RE = /^metro-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
export const OWNER_RE = /^0x[0-9a-f]{40}$/;
export const AUTH_KEY_RE = /^tskey-[A-Za-z0-9_-]{8,200}$/;
const TAG_RE = /^[a-z0-9][A-Za-z0-9.-]{0,40}$/;

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

export function cloudInit(spec: BoxSpec): string {
  const hostname = check(spec.hostname, HOSTNAME_RE, 'The host name');
  const node = check(spec.node, NODE_RE, 'The tailnet name');
  const owner = check(spec.owner, OWNER_RE, 'The owner wallet');
  const key = check(spec.tailscaleAuthKey, AUTH_KEY_RE, 'The Tailscale auth key');
  const tag = check(spec.metroTag, TAG_RE, 'The metro version');
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'export HOME=/root DEBIAN_FRONTEND=noninteractive',
    'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'exec > >(tee -a /var/log/metro-setup.log) 2>&1',
    'echo "metro setup: start $(date -u +%FT%TZ)"',
    `hostnamectl set-hostname '${hostname}'`,
    'apt-get update -y',
    'apt-get install -y curl ca-certificates git tmux unzip',
    'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
    'apt-get install -y nodejs',
    'curl -fsSL https://bun.sh/install | bash',
    'ln -sf /root/.bun/bin/bun /usr/local/bin/bun',
    'curl -fsSL https://claude.ai/install.sh | bash',
    'ln -sf /root/.local/bin/claude /usr/local/bin/claude',
    'curl -fsSL https://tailscale.com/install.sh | sh',
    `tailscale up --auth-key='${key}' --hostname='${node}' --ssh`,
    `npm install -g '@stage-labs/metro@${tag}'`,
    'mkdir -p /root/.metro/agents && chmod 700 /root/.metro/agents',
    `printf '%s\\n' '${node}' > /root/.metro/agents/.node && chmod 600 /root/.metro/agents/.node`,
    `metro service install --owner '${owner}'`,
    'echo "metro setup: done $(date -u +%FT%TZ)"',
    '',
  ].join('\n');
}
