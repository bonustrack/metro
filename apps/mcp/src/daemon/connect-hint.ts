import { hostname } from 'node:os';

const uiBase = (): string => process.env.METRO_UI_URL ?? 'https://metro.box';

const connectLink = (base: string): string =>
  `${uiBase()}/#/${new URL(base).host}`;

const ownerLine = (owner: string | null): string =>
  owner === null
    ? 'No owner is set, so no wallet can sign in. Restart with:  metro serve --owner <address>'
    : `Only ${owner} can sign in.`;

export function localConnectHint(port: number, owner: string | null): string {
  const here = `http://127.0.0.1:${String(port)}`;
  const forward = `ssh -L ${String(port)}:127.0.0.1:${String(port)} ${hostname()}`;
  return [
    'Manage this machine from the web UI:',
    '',
    `  ${connectLink(here)}`,
    '',
    `From another computer, forward the port first:  ${forward}`,
    ownerLine(owner),
    '',
  ].join('\n');
}

export function publicConnectHint(url: string, owner: string | null): string {
  return [
    'Manage this machine from the web UI, from anywhere:',
    '',
    `  ${connectLink(url)}`,
    '',
    ownerLine(owner),
    '',
  ].join('\n');
}

export const tunnelPendingHint = (kind: 'quick' | 'tailscale'): string =>
  kind === 'quick'
    ? 'Bringing up a public address through a Cloudflare quick tunnel…\n'
    : 'Publishing this daemon through Tailscale Funnel…\n';
