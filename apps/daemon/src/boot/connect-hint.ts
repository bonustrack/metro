import { hostname } from 'node:os';

const connectLink = (base: string): string => `https://metro.box/#/${new URL(base).host}`;

const ownerLine = (owner: string | null): string =>
  owner === null
    ? 'No owner is set, so nobody can sign in. Restart with:  metro serve --owner <organization id>'
    : `Only members of the organization ${owner} can sign in.`;

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

export const tunnelPendingHint = (): string =>
  'Publishing this daemon through Tailscale Funnel… (if Tailscale asks to enable Funnel, its link is in the log)\n';
