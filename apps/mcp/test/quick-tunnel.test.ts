import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentTunnelUrl,
  quickTunnelUrlIn,
  Tunnel,
  tunnelConfigFromEnv,
} from '../src/daemon/tunnel.ts';
import { publicBaseUrl } from '../src/daemon/attach-serve.ts';

const BANNER = [
  '2026-09-04T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-09-04T10:00:01Z INF +--------------------------------------------------------------------------------------------+',
  '2026-09-04T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  '2026-09-04T10:00:01Z INF |  https://tidy-words-fall-here.trycloudflare.com                                            |',
  '2026-09-04T10:00:01Z INF +--------------------------------------------------------------------------------------------+',
].join('\n');

const saved = { path: process.env.PATH, tunnel: process.env.METRO_TUNNEL, pub: process.env.METRO_PUBLIC_URL };
let bin = '';

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'metro-fake-cloudflared-'));
  delete process.env.METRO_PUBLIC_URL;
  delete process.env.METRO_TUNNEL;
});

afterEach(() => {
  process.env.PATH = saved.path;
  if (saved.tunnel === undefined) delete process.env.METRO_TUNNEL;
  else process.env.METRO_TUNNEL = saved.tunnel;
  if (saved.pub === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = saved.pub;
  rmSync(bin, { recursive: true, force: true });
});

function fakeCloudflared(script: string): void {
  const path = join(bin, 'cloudflared');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  process.env.PATH = `${bin}:${saved.path ?? ''}`;
}

const untilUrl = (tunnel: Tunnel, onUrl: { resolve: (u: string) => void }): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    onUrl.resolve = resolve;
    setTimeout(() => {
      reject(new Error('no url within 5s'));
    }, 5_000).unref();
    tunnel.start();
  });

describe('reading cloudflared', () => {
  test('the quick tunnel address is picked out of the banner, and only there', () => {
    expect(quickTunnelUrlIn(BANNER)).toBe('https://tidy-words-fall-here.trycloudflare.com');
    expect(quickTunnelUrlIn('INF Registered tunnel connection connIndex=0')).toBeNull();
    expect(quickTunnelUrlIn('https://evil.example.com/trycloudflare.com')).toBeNull();
  });

  test('METRO_TUNNEL=quick is the only spelling that configures one', () => {
    expect(tunnelConfigFromEnv()).toBeNull();
    process.env.METRO_TUNNEL = 'quick';
    expect(tunnelConfigFromEnv()).toEqual({ quick: true });
    process.env.METRO_TUNNEL = 'named';
    expect(tunnelConfigFromEnv()).toBeNull();
  });
});

describe('a quick tunnel, against a fake cloudflared', () => {
  test('the address it prints becomes the daemon public base until it exits', async () => {
    fakeCloudflared(`printf '%s\\n' '${BANNER.replace(/'/g, '')}' >&2\nexec sleep 30`);
    const onUrl = { resolve: (_u: string): void => undefined };
    const tunnel = new Tunnel(
      { quick: true },
      8420,
      (u) => {
        onUrl.resolve(u);
      },
      () => Promise.resolve(true),
    );
    const url = await untilUrl(tunnel, onUrl);
    expect(url).toBe('https://tidy-words-fall-here.trycloudflare.com');
    expect(currentTunnelUrl()).toBe(url);
    expect(publicBaseUrl()).toBe(url);
    expect(tunnel.hostname).toBe('tidy-words-fall-here.trycloudflare.com');
    tunnel.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(currentTunnelUrl()).toBeNull();
    expect(publicBaseUrl()).toBeNull();
  });

  test('METRO_PUBLIC_URL still wins over the tunnel address', async () => {
    fakeCloudflared(`printf '%s\\n' '${BANNER.replace(/'/g, '')}' >&2\nexec sleep 30`);
    process.env.METRO_PUBLIC_URL = 'https://metro.example.net/';
    const onUrl = { resolve: (_u: string): void => undefined };
    const tunnel = new Tunnel(
      { quick: true },
      8420,
      (u) => {
        onUrl.resolve(u);
      },
      () => Promise.resolve(true),
    );
    await untilUrl(tunnel, onUrl);
    expect(publicBaseUrl()).toBe('https://metro.example.net');
    tunnel.stop();
  });

  test('the link is announced only once the name resolves, and the base is live before that', async () => {
    fakeCloudflared(`printf '%s\\n' '${BANNER.replace(/'/g, '')}' >&2\nexec sleep 30`);
    const asked: string[] = [];
    let announced: string | null = null;
    let ready = false;
    const tunnel = new Tunnel(
      { quick: true },
      8420,
      (u) => {
        announced = u;
      },
      (host) => {
        asked.push(host);
        return Promise.resolve(ready);
      },
    );
    tunnel.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(currentTunnelUrl()).toBe('https://tidy-words-fall-here.trycloudflare.com');
    expect(announced).toBeNull();
    expect(asked).toEqual(['tidy-words-fall-here.trycloudflare.com']);
    ready = true;
    await new Promise((r) => setTimeout(r, 3_400));
    expect(announced).toBe('https://tidy-words-fall-here.trycloudflare.com');
    tunnel.stop();
  }, 10_000);

  test('a missing cloudflared is logged once and never retried', async () => {
    process.env.PATH = bin;
    const tunnel = new Tunnel({ quick: true }, 8420, () => undefined);
    tunnel.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(currentTunnelUrl()).toBeNull();
    tunnel.stop();
  });
});
