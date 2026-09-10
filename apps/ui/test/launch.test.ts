import { describe, expect, test } from 'bun:test';
import { launchBox, plannedHost, type LaunchDeps } from '../src/aws/launch.ts';
import { hostOf, nodeNameOf, slugOf, tailnetSuffix } from '../src/aws/settings.ts';
import { routeHash, routeSelection } from '../src/route.ts';

const IMAGE = { imageId: 'ami-new', name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20260820', creationDate: '2026-08-20T10:00:00.000Z' };

function fakeDeps(): { deps: LaunchDeps; calls: string[]; userData: string[] } {
  const calls: string[] = [];
  const userData: string[] = [];
  const deps: LaunchDeps = {
    latestImage: (creds, region) => {
      calls.push(`image ${creds.accessKeyId} ${region}`);
      return Promise.resolve(IMAGE);
    },
    run: (_creds, region, spec) => {
      calls.push(`run ${region} ${spec.imageId} ${spec.name} ${spec.node} ${spec.clientToken}`);
      userData.push(spec.userData);
      return Promise.resolve('i-0abc');
    },
    add: (host, name) => {
      calls.push(`add ${host} ${name}`);
      return Promise.resolve({ id: 'srv00000001', host, name, addedAt: '2026-09-10T00:00:00.000Z' });
    },
    record: (host, launch) => {
      calls.push(`record ${host} ${launch.instanceId} ${launch.region} ${launch.launchedAt}`);
    },
    now: () => new Date('2026-09-10T12:00:00.000Z'),
    token: () => 'tok-1',
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
    expect(launched).toMatchObject({ host: 'metro-andy.tail17c4f8.ts.net', node: 'metro-andy', instanceId: 'i-0abc', image: IMAGE });
    expect(calls).toEqual([
      'image AKIAEXAMPLE eu-west-1',
      'run eu-west-1 ami-new Andy metro-andy tok-1',
      'add metro-andy.tail17c4f8.ts.net Andy',
      'record metro-andy.tail17c4f8.ts.net i-0abc eu-west-1 2026-09-10T12:00:00.000Z',
    ]);
    expect(userData[0]).toContain("--hostname='metro-andy'");
    expect(userData[0]).toContain("--owner '0xef8305e140ac520225daf050e2f71d5fbcc543e7'");
    expect(userData[0]).toContain("hostnamectl set-hostname 'andy'");
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
    expect(nodeNameOf('andy')).toBe('metro-andy');
    expect(hostOf('metro-andy', '.tail1234.ts.net.')).toBe('metro-andy.tail1234.ts.net');
    expect(plannedHost('Andy', ' Tail1234.ts.net ')).toEqual({ slug: 'andy', node: 'metro-andy', host: 'metro-andy.tail1234.ts.net' });
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
