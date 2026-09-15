import { describe, expect, test } from 'bun:test';
import { launchOwners, mayLaunch, readLaunchConfig } from '../src/launch-config.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';

const GOOD: NodeJS.ProcessEnv = {
  METRO_AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  METRO_AWS_SECRET_ACCESS_KEY: 'secret',
  METRO_LAUNCH_TAILNET: 'tail17c4f8.ts.net',
  METRO_TAILSCALE_AUTH_KEY: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
  METRO_LAUNCH_OWNERS: OWNER,
};

describe('metro issues servers only when it is fully configured', () => {
  test('a complete environment reads back', () => {
    const result = readLaunchConfig(GOOD);
    if (!result.ok) throw new Error(`expected a config, missing ${result.missing.join(', ')}`);
    expect(result.config).toMatchObject({ tailnet: 'tail17c4f8.ts.net', owners: [OWNER] });
    expect(result.config.credentials.accessKeyId).toBe('AKIAEXAMPLE');
  });

  test('anything unset or malformed is named, and nothing half configured issues a server', () => {
    for (const [over, missing] of [
      [{ METRO_AWS_ACCESS_KEY_ID: '' }, 'METRO_AWS_ACCESS_KEY_ID'],
      [{ METRO_AWS_SECRET_ACCESS_KEY: '' }, 'METRO_AWS_SECRET_ACCESS_KEY'],
      [{ METRO_LAUNCH_TAILNET: 'example.com' }, 'METRO_LAUNCH_TAILNET'],
      [{ METRO_TAILSCALE_AUTH_KEY: 'tskey-api-nope' }, 'METRO_TAILSCALE_AUTH_KEY'],
      [{ METRO_LAUNCH_OWNERS: '' }, 'METRO_LAUNCH_OWNERS'],
    ] as const) {
      const result = readLaunchConfig({ ...GOOD, ...over });
      if (result.ok) throw new Error(`expected ${missing} to be refused`);
      expect(result.missing).toContain(missing);
    }
  });

  test('an empty environment is off, not open', () => {
    const result = readLaunchConfig({});
    expect(result.ok).toBe(false);
  });
});

describe('who may ask metro for a server', () => {
  test('the list takes several wallets, in any case, and ignores what is not an address', () => {
    expect(launchOwners(`${OWNER.toUpperCase()}, 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 ,nonsense,`)).toEqual([
      OWNER,
      '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    ]);
    expect(launchOwners('')).toEqual([]);
  });

  test('a wallet outside the list may not, whatever case it signs in with', () => {
    const result = readLaunchConfig(GOOD);
    if (!result.ok) throw new Error('expected a config');
    expect(mayLaunch(result.config, OWNER.toUpperCase())).toBe(true);
    expect(mayLaunch(result.config, '0x70997970c51812dc3a010c7d01b50e0d17dc79c8')).toBe(false);
    expect(mayLaunch(result.config, 'not an address')).toBe(false);
  });
});
