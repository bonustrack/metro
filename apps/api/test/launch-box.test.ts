import { describe, expect, test } from 'bun:test';
import { launchBox, redactKeys, type LaunchDeps } from '../src/aws/launch.ts';
import { AwsError } from '../src/aws/ec2.ts';
import { hostOf, randomNodeName, slugOf } from '../src/aws/names.ts';

function fakeDeps(full: Set<string> = new Set()): { deps: LaunchDeps; calls: string[]; userData: string[] } {
  const calls: string[] = [];
  const userData: string[] = [];
  let tokens = 0;
  const deps: LaunchDeps = {
    latestImage: (creds, region) => {
      calls.push(`image ${creds.accessKeyId} ${region}`);
      return Promise.resolve('ami-new');
    },
    run: (_creds, region, spec) => {
      calls.push(
        `run ${region} ${spec.imageId} ${spec.name} ${spec.node} ${spec.clientToken}${spec.zone === undefined ? '' : ` ${spec.zone}`}`,
      );
      userData.push(spec.userData);
      if (full.has(spec.zone ?? '*'))
        return Promise.reject(new AwsError('InsufficientInstanceCapacity', 'Insufficient capacity.'));
      return Promise.resolve('i-0abc');
    },
    zones: (_creds, region) => {
      calls.push(`zones ${region}`);
      return Promise.resolve(['eu-west-1a', 'eu-west-1b', 'eu-west-1c']);
    },
    node: () => 'metro-abc123',
    token: () => `tok-${String(++tokens)}`,
  };
  return { deps, calls, userData };
}

const INPUT = {
  name: 'Andy',
  region: 'eu-west-1',
  owner: 'org_01M2TNE064H99ECTG4X228Y6B6',
  tailnet: 'tail17c4f8.ts.net',
  authKey: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's' },
};

describe('metro issuing a box', () => {
  test('resolves the image, runs the instance, and answers the host it will be reachable on', async () => {
    const { deps, calls, userData } = fakeDeps();
    const launched = await launchBox(INPUT, deps);
    expect(launched).toEqual({
      host: 'metro-abc123.tail17c4f8.ts.net',
      node: 'metro-abc123',
      instanceId: 'i-0abc',
      region: 'eu-west-1',
      zone: null,
      imageId: 'ami-new',
    });
    expect(calls).toEqual(['image AKIAEXAMPLE eu-west-1', 'run eu-west-1 ami-new metro:andy metro-abc123 tok-1']);
    expect(userData[0]).toContain("--hostname='metro-abc123'");
    expect(userData[0]).toContain("--owner 'org_01M2TNE064H99ECTG4X228Y6B6'");
    expect(userData[0]).toContain("hostnamectl set-hostname 'andy'");
  });

  test('no capacity in the zone AWS picked is retried in every zone, each with its own token', async () => {
    const { deps, calls } = fakeDeps(new Set(['*', 'eu-west-1a']));
    const launched = await launchBox(INPUT, deps);
    expect(launched.zone).toBe('eu-west-1b');
    expect(calls).toEqual([
      'image AKIAEXAMPLE eu-west-1',
      'run eu-west-1 ami-new metro:andy metro-abc123 tok-1',
      'zones eu-west-1',
      'run eu-west-1 ami-new metro:andy metro-abc123 tok-2 eu-west-1a',
      'run eu-west-1 ami-new metro:andy metro-abc123 tok-3 eu-west-1b',
    ]);
  });

  test('no capacity anywhere in the region says so, naming the zones tried', async () => {
    const { deps } = fakeDeps(new Set(['*', 'eu-west-1a', 'eu-west-1b', 'eu-west-1c']));
    await expect(launchBox(INPUT, deps)).rejects.toThrow(
      'no t4g.medium capacity in eu-west-1 right now, in any of its zones (eu-west-1a, eu-west-1b, eu-west-1c)',
    );
  });

  test('any other refusal is not retried', async () => {
    const { deps, calls } = fakeDeps();
    deps.run = () => Promise.reject(new AwsError('UnauthorizedOperation', 'You are not authorized.'));
    await expect(launchBox(INPUT, deps)).rejects.toThrow('not authorized');
    expect(calls.filter((c) => c.startsWith('zones'))).toEqual([]);
  });

  test('a name, key or owner the script cannot carry is refused before AWS is asked', async () => {
    for (const [over, reason] of [
      [{ name: '***' }, 'name'],
      [{ authKey: 'nope' }, 'Tailscale auth key'],
      [{ owner: '' }, 'The owner'],
    ] as const) {
      const { deps, calls } = fakeDeps();
      await expect(launchBox({ ...INPUT, ...over }, deps)).rejects.toThrow(reason);
      expect(calls).toEqual([]);
    }
  });
});

describe('an auth key never reaches whoever reads the boot log', () => {
  test('every tskey in the console output is redacted, wherever it sits', () => {
    const text = 'tailscale up --auth-key=tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop --ssh\nnext line';
    expect(redactKeys(text)).toBe('tailscale up --auth-key=tskey-REDACTED --ssh\nnext line');
    expect(redactKeys('tskey-api-xyz and tskey-auth-abc')).toBe('tskey-REDACTED and tskey-REDACTED');
    expect(redactKeys('nothing to hide')).toBe('nothing to hide');
  });
});

describe('names and addresses', () => {
  test('the host name is derived from the custom name, lowercase and dashed', () => {
    expect(slugOf(' Andy ')).toBe('andy');
    expect(slugOf('Client Two!')).toBe('client-two');
    expect(slugOf('--')).toBe('');
    expect(slugOf('x'.repeat(50))).toHaveLength(30);
  });

  test('the tailnet name is random, so two boxes can never clash', () => {
    const names = new Set(Array.from({ length: 50 }, () => randomNodeName()));
    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(/^metro-[a-z0-9]{6}$/);
    expect(hostOf('metro-abc123', '.tail1234.ts.net.')).toBe('metro-abc123.tail1234.ts.net');
  });
});
