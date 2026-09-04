import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentTunnelUrl, driverFor, funnelDriver, funnelUrlIn, Tunnel } from '../src/daemon/tunnel.ts';
import { publicBaseUrl } from '../src/daemon/attach-serve.ts';
import { tunnelPendingHint } from '../src/daemon/connect-hint.ts';

const FOREGROUND = [
  'Available on the internet:',
  '',
  'https://suzy.tail1234.ts.net/',
  '|-- proxy http://127.0.0.1:8420',
  '',
  'Press Ctrl+C to exit.',
].join('\n');

const REFUSED = [
  'Funnel is not enabled on your tailnet.',
  'To enable, visit:',
  '',
  '\thttps://login.tailscale.com/f/funnel?node=nabc123',
].join('\n');

const saved = { path: process.env.PATH, bin: process.env.METRO_TAILSCALE_BIN, pub: process.env.METRO_PUBLIC_URL };
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-fake-tailscale-'));
  delete process.env.METRO_PUBLIC_URL;
  delete process.env.METRO_TAILSCALE_BIN;
});

afterEach(() => {
  process.env.PATH = saved.path;
  if (saved.bin === undefined) delete process.env.METRO_TAILSCALE_BIN;
  else process.env.METRO_TAILSCALE_BIN = saved.bin;
  if (saved.pub === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = saved.pub;
  rmSync(dir, { recursive: true, force: true });
});

function fakeTailscale(script: string, name = 'tailscale'): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  process.env.PATH = `${dir}:${saved.path ?? ''}`;
  return path;
}

const untilUrl = (tunnel: Tunnel, onUrl: { resolve: (u: string) => void }): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    onUrl.resolve = resolve;
    setTimeout(() => {
      reject(new Error('no url within 5s'));
    }, 5_000).unref();
    tunnel.start();
  });

describe('reading tailscale funnel', () => {
  test('the node name is picked out of the foreground block, with or without a port, and nowhere else', () => {
    expect(funnelUrlIn(FOREGROUND)).toBe('https://suzy.tail1234.ts.net');
    expect(funnelUrlIn('https://Suzy.Tail1234.ts.net:8443/')).toBe('https://suzy.tail1234.ts.net:8443');
    expect(funnelUrlIn('https://evil.example.com/suzy.tail1234.ts.net')).toBeNull();
    expect(funnelUrlIn('https://suzy.tail1234.ts.net.evil.example')).toBeNull();
    expect(funnelUrlIn(REFUSED)).toBeNull();
  });

  test('the driver runs the foreground funnel on the daemon port, from the binary the CLI found', () => {
    expect(funnelDriver(8420, '/Applications/Tailscale.app/Contents/MacOS/Tailscale')).toMatchObject({
      command: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      args: ['funnel', '8420'],
      waitsForDns: false,
    });
    process.env.METRO_TAILSCALE_BIN = '/opt/bin/tailscale';
    expect(driverFor('tailscale', 8421).command).toBe('/opt/bin/tailscale');
    expect(driverFor('quick', 8421).command).toBe('cloudflared');
    expect(tunnelPendingHint('tailscale')).toContain('Tailscale Funnel');
    expect(tunnelPendingHint('quick')).toContain('quick tunnel');
  });
});

describe('a funnel, against a fake tailscale', () => {
  test('the node address is announced at once, no DNS wait, and is the public base until it exits', async () => {
    fakeTailscale(`printf '%s\\n' '${FOREGROUND.replace(/'/g, '')}'\nexec sleep 30`);
    const onUrl = { resolve: (_u: string): void => undefined };
    const asked: string[] = [];
    const tunnel = new Tunnel(
      funnelDriver(8420, 'tailscale'),
      (u) => {
        onUrl.resolve(u);
      },
      (host) => {
        asked.push(host);
        return Promise.resolve(false);
      },
    );
    const url = await untilUrl(tunnel, onUrl);
    expect(url).toBe('https://suzy.tail1234.ts.net');
    expect(asked).toEqual([]);
    expect(currentTunnelUrl()).toBe(url);
    expect(publicBaseUrl()).toBe(url);
    tunnel.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(currentTunnelUrl()).toBeNull();
    expect(publicBaseUrl()).toBeNull();
  });

  test('a refusal leaves no address and is retried, never mistaken for one', async () => {
    fakeTailscale(`printf '%s\\n' '${REFUSED.replace(/'/g, '')}' >&2\nexit 1`);
    let announced: string | null = null;
    const tunnel = new Tunnel(funnelDriver(8420, 'tailscale'), (u) => {
      announced = u;
    });
    tunnel.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(announced).toBeNull();
    expect(currentTunnelUrl()).toBeNull();
    tunnel.stop();
  });

  test('a missing tailscale binary is logged once and never retried', async () => {
    process.env.PATH = dir;
    const tunnel = new Tunnel(funnelDriver(8420, 'tailscale'), () => undefined);
    tunnel.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(currentTunnelUrl()).toBeNull();
    tunnel.stop();
  });
});
