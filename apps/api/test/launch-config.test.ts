import { describe, expect, test } from 'bun:test';
import { readLaunchConfig } from '../src/launch-config.ts';

const GOOD: NodeJS.ProcessEnv = {
  METRO_AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  METRO_AWS_SECRET_ACCESS_KEY: 'secret',
  METRO_LAUNCH_TAILNET: 'tail17c4f8.ts.net',
  METRO_TAILSCALE_AUTH_KEY: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
};

describe('metro issues servers only when it is fully configured', () => {
  test('a complete environment reads back', () => {
    const result = readLaunchConfig(GOOD);
    if (!result.ok) throw new Error(`expected a config, missing ${result.missing.join(', ')}`);
    expect(result.config).toMatchObject({ tailnet: 'tail17c4f8.ts.net' });
    expect(result.config.credentials.accessKeyId).toBe('AKIAEXAMPLE');
  });

  test('anything unset or malformed is named, and nothing half configured issues a server', () => {
    for (const [over, missing] of [
      [{ METRO_AWS_ACCESS_KEY_ID: '' }, 'METRO_AWS_ACCESS_KEY_ID'],
      [{ METRO_AWS_SECRET_ACCESS_KEY: '' }, 'METRO_AWS_SECRET_ACCESS_KEY'],
      [{ METRO_LAUNCH_TAILNET: 'example.com' }, 'METRO_LAUNCH_TAILNET'],
      [{ METRO_TAILSCALE_AUTH_KEY: 'tskey-api-nope' }, 'METRO_TAILSCALE_AUTH_KEY'],
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
