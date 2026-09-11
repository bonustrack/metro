import { describe, expect, test } from 'bun:test';
import { launchBox, plannedHost, type LaunchDeps } from '../src/aws/launch.ts';
import { AwsError } from '../src/aws/ec2.ts';
import { hostOf, randomNodeName, slugOf, tailnetSuffix } from '../src/aws/settings.ts';
import { routeHash, routeSelection } from '../src/route.ts';

const IMAGE = { imageId: 'ami-new', name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20260820', creationDate: '2026-08-20T10:00:00.000Z' };

function fakeDeps(full: Set<string> = new Set()): { deps: LaunchDeps; calls: string[]; userData: string[] } {
  const calls: string[] = [];
  const userData: string[] = [];
  let tokens = 0;
  const deps: LaunchDeps = {
    latestImage: (creds, region) => {
      calls.push(`image ${creds.accessKeyId} ${region}`);
      return Promise.resolve(IMAGE);
    },
    run: (_creds, region, spec) => {
      calls.push(`run ${region} ${spec.imageId} ${spec.name} ${spec.node} ${spec.clientToken}${spec.zone === undefined ? '' : ` ${spec.zone}`}`);
      userData.push(spec.userData);
      if (full.has(spec.zone ?? '*')) return Promise.reject(new AwsError('InsufficientInstanceCapacity', 'Insufficient capacity.'));
      return Promise.resolve('i-0abc');
    },
    zones: (_creds, region) => {
      calls.push(`zones ${region}`);
      return Promise.resolve(['eu-west-1a', 'eu-west-1b', 'eu-west-1c']);
    },
    add: (host, name) => {
      calls.push(`add ${host} ${name}`);
      return Promise.resolve({ id: 'srv00000001', host, name, addedAt: '2026-09-10T00:00:00.000Z' });
    },
    record: (host, launch) => {
      calls.push(`record ${host} ${launch.instanceId} ${launch.region} ${launch.launchedAt}`);
    },
    now: () => new Date('2026-09-10T12:00:00.000Z'),
    token: () => `tok-${String(++tokens)}`,
    node: () => 'metro-abc123',
  };
  return { deps, calls, userData };
}

const INPUT = {
  name: ' Andy ',
  region: 'eu-west-1',
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's' },
  tailscaleAuthKey: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
  tailnet: 'tail17c4f8.ts.net',
  owner: '0xEF8305E140AC520225DAF050E2F71D5FBCC543E7',
};

describe('launching a box', () => {
  test('resolves the image, runs the instance, then lists the host it will answer on', async () => {
    const { deps, calls, userData } = fakeDeps();
    const launched = await launchBox(INPUT, deps);
    expect(launched).toMatchObject({ host: 'metro-abc123.tail17c4f8.ts.net', node: 'metro-abc123', instanceId: 'i-0abc', zone: null, image: IMAGE });
    expect(calls).toEqual([
      'image AKIAEXAMPLE eu-west-1',
      'run eu-west-1 ami-new Andy metro-abc123 tok-1',
      'add metro-abc123.tail17c4f8.ts.net Andy',
      'record metro-abc123.tail17c4f8.ts.net i-0abc eu-west-1 2026-09-10T12:00:00.000Z',
    ]);
    expect(userData[0]).toContain("--hostname='metro-abc123'");
    expect(userData[0]).toContain("--owner '0xef8305e140ac520225daf050e2f71d5fbcc543e7'");
    expect(userData[0]).toContain("hostnamectl set-hostname 'andy'");
  });

  test('no capacity in the zone AWS picked is retried in every zone of the region, each with its own token', async () => {
    const { deps, calls } = fakeDeps(new Set(['*', 'eu-west-1a']));
    const launched = await launchBox(INPUT, deps);
    expect(launched.zone).toBe('eu-west-1b');
    expect(calls).toEqual([
      'image AKIAEXAMPLE eu-west-1',
      'run eu-west-1 ami-new Andy metro-abc123 tok-1',
      'zones eu-west-1',
      'run eu-west-1 ami-new Andy metro-abc123 tok-2 eu-west-1a',
      'run eu-west-1 ami-new Andy metro-abc123 tok-3 eu-west-1b',
      'add metro-abc123.tail17c4f8.ts.net Andy',
      'record metro-abc123.tail17c4f8.ts.net i-0abc eu-west-1 2026-09-10T12:00:00.000Z',
    ]);
  });

  test('no capacity anywhere in the region says so, naming the zones tried, and adds no server', async () => {
    const { deps, calls } = fakeDeps(new Set(['*', 'eu-west-1a', 'eu-west-1b', 'eu-west-1c']));
    await expect(launchBox(INPUT, deps)).rejects.toThrow('no t4g.medium capacity in eu-west-1 right now, in any of its zones (eu-west-1a, eu-west-1b, eu-west-1c)');
    expect(calls.filter((c) => c.startsWith('add'))).toEqual([]);
  });

  test('any other refusal is not retried', async () => {
    const { deps, calls } = fakeDeps();
    deps.run = () => Promise.reject(new AwsError('UnauthorizedOperation', 'You are not authorized to perform this operation.'));
    await expect(launchBox(INPUT, deps)).rejects.toThrow('not authorized');
    expect(calls.filter((c) => c.startsWith('zones'))).toEqual([]);
  });

  test('a bad region, name, tailnet or key is refused before AWS is asked', async () => {
    for (const [over, reason] of [
      [{ region: 'europe' }, 'region'],
      [{ name: '***' }, 'name'],
      [{ tailnet: 'example.com' }, 'tailnet'],
      [{ tailscaleAuthKey: 'nope' }, 'Tailscale auth key'],
      [{ owner: '' }, 'owner wallet'],
    ] as const) {
      const { deps, calls } = fakeDeps();
      await expect(launchBox({ ...INPUT, ...over }, deps)).rejects.toThrow(reason);
      expect(calls).toEqual([]);
    }
  });
});

describe('names and addresses', () => {
  test('the tailnet name is derived from the custom name, lowercase and dashed', () => {
    expect(slugOf(' Andy ')).toBe('andy');
    expect(slugOf('Client Two!')).toBe('client-two');
    expect(slugOf('--')).toBe('');
    expect(slugOf('x'.repeat(50))).toHaveLength(30);
    expect(hostOf('metro-abc123', '.tail1234.ts.net.')).toBe('metro-abc123.tail1234.ts.net');
    expect(plannedHost('Andy', ' Tail1234.ts.net ', 'metro-abc123')).toEqual({ slug: 'andy', node: 'metro-abc123', host: 'metro-abc123.tail1234.ts.net' });
    const names = new Set(Array.from({ length: 50 }, () => randomNodeName()));
    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(/^metro-[a-z0-9]{6}$/);
  });

  test('the tailnet is read off an existing Funnel address in the server list', () => {
    expect(tailnetSuffix(['127.0.0.1:8420', 'metro-h3c8yc.tail17c4f8.ts.net', 'metro-2tcn8d.tail17c4f8.ts.net'])).toBe('tail17c4f8.ts.net');
    expect(tailnetSuffix(['127.0.0.1:8420', 'example.com'])).toBeNull();
    expect(tailnetSuffix([])).toBeNull();
  });

  test('#/launch is a page of its own', () => {
    expect(routeSelection('#/launch')).toEqual({ kind: 'launch' });
    expect(routeHash({ kind: 'launch' })).toBe('#/launch');
    expect(routeSelection('#/launch/').kind).not.toBe('launch');
  });
});
