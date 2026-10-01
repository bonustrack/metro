import { describe, expect, test } from 'bun:test';
import { readLaunchConfig } from '../src/launch-config.ts';

const GOOD: NodeJS.ProcessEnv = {
  METRO_AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  METRO_AWS_SECRET_ACCESS_KEY: 'secret',
  METRO_LAUNCH_TAILNET: 'tail17c4f8.ts.net',
  METRO_TAILSCALE_CLIENT_ID: 'kCLIENT1CNTRL',
  METRO_TAILSCALE_CLIENT_SECRET: 'tskey-client-kCLIENT1CNTRL-abcdefghijklmnop',
};

describe('metro issues servers only when it is fully configured', () => {
  test('a complete environment reads back', () => {
    const result = readLaunchConfig(GOOD);
    if (!result.ok) throw new Error(`expected a config, missing ${result.missing.join(', ')}`);
    expect(result.config).toMatchObject({ tailnet: 'tail17c4f8.ts.net' });
    expect(result.config.credentials.accessKeyId).toBe('AKIAEXAMPLE');
    expect(result.config.tailscale).toEqual({ id: 'kCLIENT1CNTRL', secret: 'tskey-client-kCLIENT1CNTRL-abcdefghijklmnop' });
  });

  test('anything unset or malformed is named, and nothing half configured issues a server', () => {
    for (const [over, missing] of [
      [{ METRO_AWS_ACCESS_KEY_ID: '' }, 'METRO_AWS_ACCESS_KEY_ID'],
      [{ METRO_AWS_SECRET_ACCESS_KEY: '' }, 'METRO_AWS_SECRET_ACCESS_KEY'],
      [{ METRO_LAUNCH_TAILNET: 'example.com' }, 'METRO_LAUNCH_TAILNET'],
    ] as const) {
      const result = readLaunchConfig({ ...GOOD, ...over });
      if (result.ok) throw new Error(`expected ${missing} to be refused`);
      expect(result.missing).toContain(missing);
    }
  });

  test('without a well-formed OAuth client, the AWS side still works and no key is ever made', () => {
    for (const over of [
      { METRO_TAILSCALE_CLIENT_ID: '' },
      { METRO_TAILSCALE_CLIENT_SECRET: '' },
      { METRO_TAILSCALE_CLIENT_SECRET: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop' },
      { METRO_TAILSCALE_CLIENT_SECRET: 'tskey-api-kABCDEF1CNTRL-abcdefghijklmnop' },
    ]) {
      const result = readLaunchConfig({ ...GOOD, ...over });
      if (!result.ok) throw new Error('expected the AWS side to stay on');
      expect(result.config.tailscale).toBeNull();
    }
  });

  test('the shared reusable auth key is never read again', () => {
    const result = readLaunchConfig({ ...GOOD, METRO_TAILSCALE_CLIENT_SECRET: '', METRO_TAILSCALE_AUTH_KEY: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop' });
    if (!result.ok) throw new Error('expected the AWS side to stay on');
    expect(JSON.stringify(result.config)).not.toContain('tskey-auth-');
    expect(result.config.tailscale).toBeNull();
  });

  test('an empty environment is off, not open', () => {
    const result = readLaunchConfig({});
    expect(result.ok).toBe(false);
  });
});
