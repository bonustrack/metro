import { hostname } from 'node:os';

const uiBase = (): string => process.env.METRO_UI_URL ?? 'https://metro.box';

export const connectLink = (base: string): string => {
  try {
    return `${uiBase()}/#/${new URL(base).host}`;
  } catch {
    return `${uiBase()}/#/connect/${encodeURIComponent(base)}`;
  }
};

export function localConnectHint(port: number): string {
  const here = `http://127.0.0.1:${String(port)}`;
  const forward = `ssh -L ${String(port)}:127.0.0.1:${String(port)} ${hostname()}`;
  return [
    'Manage this machine from the web UI:',
    '',
    `  ${connectLink(here)}`,
    '',
    `From another computer, forward the port first:  ${forward}`,
    '',
  ].join('\n');
}

export function publicConnectHint(url: string): string {
  return [
    'Manage this machine from the web UI, from anywhere:',
    '',
    `  ${connectLink(url)}`,
    '',
    'Sign in right away: the first wallet to sign in owns this machine.',
    '',
  ].join('\n');
}

export const tunnelPendingHint = (): string =>
  'Bringing up a public address through a Cloudflare quick tunnel…\n';
