import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError } from '@metro-labs/http/api-error';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleUsageApiRequest, resetUsageState, type MetricsAws, type UsageApiDeps } from '../src/usage.js';
import { AwsError, type AwsCredentials } from '../src/aws/ec2.js';
import type { Metric, Point } from '../src/aws/cloudwatch.js';
import type { InstanceFacts } from '../src/aws/teardown.js';
import type { UsageRow } from '../src/db/usage.js';
import type { ConfigResult } from '../src/launch-config.js';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';

const CONFIG: ConfigResult = {
  ok: true,
  config: { credentials: { accessKeyId: 'AKIAMETRO', secretAccessKey: 's' }, role: null, tailnet: 'tail17c4f8.ts.net', tailscale: null },
};
const NOW = Date.parse('2026-09-29T10:07:00Z');
const LAUNCHED = 'srv00000001';
const HAND_ADDED = 'srv00000003';
const ROWS: Record<string, UsageRow> = {
  [LAUNCHED]: { host: 'metro-thrw01.tail17c4f8.ts.net', link: { instanceId: 'i-0abc', region: 'us-east-1', account: null } },
  [HAND_ADDED]: { host: 'metro-6vfdky.tail17c4f8.ts.net', link: null },
};
const AGENT: Metric[] = [
  { namespace: 'CWAgent', name: 'mem_used_percent', dimensions: [{ name: 'InstanceId', value: 'i-0abc' }] },
  { namespace: 'CWAgent', name: 'disk_used_percent', dimensions: [{ name: 'InstanceId', value: 'i-0abc' }, { name: 'path', value: '/' }] },
];

interface Cloud {
  calls: string[];
  keys: string[];
  metrics: Metric[];
  instance: InstanceFacts | null;
  starts: Record<string, Point[]>;
  refuse: Partial<Record<'data' | 'associate', AwsError>>;
}

let cloud: Cloud;
let config: ConfigResult = CONFIG;

const instance = (over: Partial<InstanceFacts> = {}): InstanceFacts => ({
  instanceId: 'i-0abc',
  state: 'running',
  type: 't4g.medium',
  tags: { metro: 'metro-thrw01' },
  disks: [],
  profile: null,
  ...over,
});

const refused = (verb: keyof Cloud['refuse']): Promise<never> | null => {
  const err = cloud.refuse[verb];
  return err === undefined ? null : Promise.reject(err);
};

const note = (verb: string, credentials: AwsCredentials): void => {
  cloud.calls.push(verb);
  cloud.keys.push(credentials.accessKeyId);
};

const aws: MetricsAws = {
  list: (credentials, region) => {
    note(`list ${region}`, credentials);
    return Promise.resolve(cloud.metrics);
  },
  data: (credentials, _region, queries) => {
    note(`data ${queries.map((q) => `${q.id}/${String(q.periodSeconds)}`).join(' ')}`, credentials);
    const at = (m: number): Point => ({ at: NOW - m * 60_000, value: m });
    const points = (id: string): Point[] => cloud.starts[id] ?? (id === 'status' ? [] : [at(20), at(10)]);
    return refused('data') ?? Promise.resolve(new Map(queries.map((q) => [q.id, points(q.id)])));
  },
  describe: (credentials, _region, instanceId) => {
    note(`describe ${instanceId}`, credentials);
    return Promise.resolve(cloud.instance === null ? [] : [cloud.instance]);
  },
  associate: (credentials, _region, instanceId, profile) => {
    note(`associate ${instanceId} ${profile}`, credentials);
    return refused('associate') ?? Promise.resolve();
  },
};

const deps: UsageApiDeps = {
  config: () => config,
  aws,
  now: () => NOW,
  lookup: (owner, id) => {
    const row = ROWS[id];
    return owner === TEST_OWNER && row !== undefined ? Promise.resolve(row) : Promise.reject(new ApiError('no such server', 404));
  },
  keys: new SigningKeys('http://127.0.0.1:1/nowhere'),
};

let server: Server;
let base = '';

beforeAll(async () => {
  deps.keys = await testKeys();
  server = createServer((req, res) => {
    if (handleUsageApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  config = CONFIG;
  cloud = { calls: [], keys: [], metrics: AGENT, instance: instance(), starts: {}, refuse: {} };
  resetUsageState();
});

const get = async (id: string, range = '1h', who = TEST_OWNER): Promise<Response> =>
  fetch(`${base}/api/servers/${id}/usage?range=${range}`, { headers: { authorization: await auth(who, 'member') } });

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

describe('the usage charts of a server', () => {
  test('an unsigned request, another organization and a bad range are refused', async () => {
    expect((await fetch(`${base}/api/servers/${LAUNCHED}/usage`)).status).toBe(401);
    expect((await get(LAUNCHED, '1h', TEST_STRANGER)).status).toBe(404);
    expect((await get(LAUNCHED, '2y')).status).toBe(400);
    expect(cloud.calls).toEqual([]);
  });

  test('a server with no instance Metro launched, in another AWS account or on DigitalOcean, has no charts yet and AWS is never asked', async () => {
    const answer = await body(await get(HAND_ADDED));
    expect(answer).toEqual({ available: false, reason: expect.stringContaining('Charts are not available for this server yet.') as unknown as string });
    expect(answer.reason).toContain('DigitalOcean');
    config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] };
    expect(await body(await get(LAUNCHED))).toEqual({ available: false, reason: expect.stringContaining('no AWS account') as unknown as string });
    expect(cloud.calls).toEqual([]);
  });

  test('a launched server reads CPU from EC2 and memory and disk from the agent namespace, with Metro’s own key', async () => {
    const answer = await body(await get(LAUNCHED));
    expect(answer).toMatchObject({ available: true, instanceId: 'i-0abc', region: 'us-east-1', range: '1h', note: null });
    expect(answer.to).toBe(Date.parse('2026-09-29T10:10:00Z'));
    expect(answer.from).toBe(Date.parse('2026-09-29T09:10:00Z'));
    expect(answer.cpu).toEqual({ stepMs: 300_000, points: [{ at: NOW - 1_200_000, value: 20 }, { at: NOW - 600_000, value: 10 }] });
    expect((answer.memory as { stepMs: number }).stepMs).toBe(60_000);
    expect(cloud.calls).toEqual(['list us-east-1', 'data cpu/300 credits/300 status/300 memory/60 disk/60 server/60 metro/60']);
    expect(new Set(cloud.keys)).toEqual(new Set(['AKIAMETRO']));
  });

  test('restarts come from the start the daemon sends, dated by its value, in the range only, a repeat counted once', async () => {
    const sec = (iso: string): number => Date.parse(iso) / 1000;
    const start = (iso: string): Point => ({ at: Date.parse(iso), value: sec(iso) });
    cloud.starts = {
      server: [start('2026-09-29T08:00:00Z'), start('2026-09-29T09:30:00Z'), { at: Date.parse('2026-09-29T09:32:00Z'), value: sec('2026-09-29T09:30:01Z') }],
      metro: [start('2026-09-29T09:50:00Z'), start('2026-09-29T09:50:00Z')],
    };
    const answer = await body(await get(LAUNCHED));
    expect(answer.restarts).toEqual([
      { at: Date.parse('2026-09-29T09:30:00Z'), kind: 'server' },
      { at: Date.parse('2026-09-29T09:50:00Z'), kind: 'metro' },
    ]);
    cloud.starts = {};
    expect((await body(await get(LAUNCHED))).restarts).toEqual([]);
  });

  test('longer ranges use longer periods', async () => {
    await get(LAUNCHED, '7d');
    expect(cloud.calls.at(-1)).toBe('data cpu/3600 credits/3600 status/3600 memory/3600 disk/3600 server/60 metro/60');
  });

  test('with no agent readings, a launched server gets the metro-box role once, and the page says so', async () => {
    cloud.metrics = [];
    const first = await body(await get(LAUNCHED));
    expect(first.note).toContain('Metro gave this server the metro-box role');
    expect(cloud.calls).toEqual(['list us-east-1', 'data cpu/300 credits/300 status/300 server/60 metro/60', 'describe i-0abc', 'associate i-0abc metro-box']);
    cloud.calls = [];
    expect((await body(await get(LAUNCHED))).note).toContain('Metro gave this server');
    expect(cloud.calls).not.toContain('describe i-0abc');
  });

  test('two pages open at once give the role only once', async () => {
    cloud.metrics = [];
    const answers = await Promise.all([get(LAUNCHED), get(LAUNCHED, '24h'), get(LAUNCHED, '7d')]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(cloud.calls.filter((c) => c.startsWith('associate'))).toEqual(['associate i-0abc metro-box']);
  });

  test('a server that already has a role is only told to update Metro', async () => {
    cloud.metrics = [];
    cloud.instance = instance({ profile: 'arn:aws:iam::787391402827:instance-profile/metro-box' });
    expect((await body(await get(LAUNCHED))).note).toContain('Update Metro on this server');
    expect(cloud.calls.some((c) => c.startsWith('associate'))).toBe(false);
  });

  test('an instance whose metro tag names another box never gets the role', async () => {
    cloud.metrics = [];
    cloud.instance = instance({ tags: { metro: 'metro-fa79qt' } });
    expect((await body(await get(LAUNCHED))).note).toContain('Modify IAM role');
    expect(cloud.calls.some((c) => c.startsWith('associate'))).toBe(false);
  });

  test('a refused attach is explained and the charts still answer', async () => {
    cloud.metrics = [];
    cloud.refuse.associate = new AwsError('UnauthorizedOperation', 'no', 'ec2:AssociateIamInstanceProfile');
    const answer = await body(await get(LAUNCHED));
    expect(answer.available).toBe(true);
    expect(answer.note).toContain('AWS refused ec2:AssociateIamInstanceProfile. Add it to the policy Metro uses in this AWS account.');
  });

  test('a CloudWatch refusal is 503 with the reason', async () => {
    cloud.refuse.data = new AwsError('AccessDenied', 'no', 'cloudwatch:GetMetricData');
    const refusedData = await get(LAUNCHED);
    expect(refusedData.status).toBe(503);
    expect((await body(refusedData)).error).toContain('AWS refused cloudwatch:GetMetricData. Add it to the policy Metro uses in this AWS account.');
  });
});
