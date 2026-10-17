import { describe, expect, test } from 'bun:test';
import type { LookupAddress } from 'node:dns';
import { egressFetch, publicAddress, type Resolve } from '../src/egress.ts';

const resolving = (addresses: LookupAddress[]): Resolve => () => Promise.resolve(addresses);

const refusal = async (url: string, resolve: Resolve = resolving([{ address: '93.184.216.34', family: 4 }])): Promise<string> => {
  try {
    await egressFetch(resolve)(url, { signal: AbortSignal.timeout(5_000) });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return 'reached';
};

describe('which addresses api.metro.box may reach for an organization connector', () => {
  test('public addresses pass, private, local and special ones do not', () => {
    for (const ok of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '93.184.216.34'])
      expect(publicAddress(ok, 4)).toBe(true);
    for (const no of ['10.0.0.1', '100.64.0.1', '100.100.100.100', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '0.0.0.0', 'not-an-ip'])
      expect(publicAddress(no, 4)).toBe(false);
    for (const ok of ['2606:4700::1', '2a09:8280:1::12f:b859:0', '2001:4860:4860::8888'])
      expect(publicAddress(ok, 6)).toBe(true);
    for (const no of ['::1', '::', 'fdaa:0:1::3', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:8.8.8.8', '::ffff:10.0.0.1', '64:ff9b::808:808', '2001::1', '2001:db8::1', '2002:c000:204::1'])
      expect(publicAddress(no, 6)).toBe(false);
  });

  test('only https goes out, and never to a private address literal', async () => {
    let resolutions = 0;
    const resolve: Resolve = () => { resolutions += 1; throw new Error('Must not resolve an invalid public URL'); };
    for (const url of ['http://vendor.example/mcp', 'https://user:pass@vendor.example/mcp', 'https://127.0.0.1/mcp', 'https://[::1]/mcp', 'https://[fdaa:0:1::3]:4280/v1', 'https://169.254.169.254/latest/meta-data', 'https://vendor.example./mcp', 'https://@vendor.example/mcp', 'https://vendor.example/mcp?key=secret#fragment']) {
      expect(await refusal(url, resolve)).toBe('Organization connectors require a public HTTPS address without user information or a fragment.');
    }
    expect(resolutions).toBe(0);
  });

  test('oversized request bodies fail before resolving or opening a connection', async () => {
    let resolutions = 0;
    const send = egressFetch(() => { resolutions += 1; return Promise.resolve([{ address: '93.184.216.34', family: 4 }]); }, { bodyMax: 1024, idleMs: 20_000 });
    await expect(send('https://vendor.example/token', { method: 'POST', body: 'x'.repeat(1025) })).rejects.toThrow('larger than Metro sends');
    expect(resolutions).toBe(0);
  });

  test('a name is refused when any of its addresses is private, so a rebinding answer cannot slip through', async () => {
    expect(await refusal('https://inside.example/mcp', resolving([{ address: '10.0.0.5', family: 4 }]))).toContain('private address');
    expect(await refusal('https://mixed.example/mcp', resolving([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]))).toContain('private address');
    expect(await refusal('https://six.example/mcp', resolving([{ address: 'fdaa::3', family: 6 }]))).toContain('private address');
    expect(await refusal('https://nothing.example/mcp', resolving([]))).toContain('no address');
    expect(await refusal('https://broken.example/mcp', () => Promise.reject(new Error('ENOTFOUND broken.example')))).toContain('ENOTFOUND');
  });
});
