import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleLatestApiRequest, resetLatestCache, type LatestApiDeps } from '../src/usage-latest.js';
import { resetUsageState, type MetricsAws } from '../src/usage.js';
import { AwsError } from '../src/aws/ec2.js';
import type { Metric, Point } from '../src/aws/cloudwatch.js';
import type { LinkedRow } from '../src/db/usage.js';
import type { ConfigResult } from '../src/launch-config.js';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';

const CONFIG: ConfigResult = {
  ok: true,
  config: { credentials: { accessKeyId: 'AKIAMETRO', secretAccessKey: 's' }, tailnet: 'tail17c4f8.ts.net', authKey: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop' },
};
const START = Date.parse('2026-09-29T10:07:00Z');
const ROLE = 'arn:aws:iam::123456789012:role/metro-cloudwatch-read';
const ROWS: Record<string, LinkedRow[]> = {
  [TEST_OWNER]: [
    { id: 'srv00000001', link: { instanceId: 'i-0abc', region: 'us-east-1', roleArn: null } },
    { id: 'srv00000002', link: { instanceId: 'i-0bcd', region: 'us-east-1', roleArn: null } },
    { id: 'srv00000003', link: { instanceId: 'i-0def', region: 'eu-central-2', roleArn: ROLE } },
    { id: 'srv00000004', link: null },
  ],
  [TEST_STRANGER]: [{ id: 'srv00000009', link: { instanceId: 'i-0fff', region: 'us-east-1', roleArn: null } }],
};
const agentMetrics = (instanceId: string): Metric[] => [
  { namespace: 'CWAgent', name: 'mem_used_percent', dimensions: [{ name: 'InstanceId', value: instanceId }] },
  { namespace: 'CWAgent', name: 'disk_used_percent', dimensions: [{ name: 'InstanceId', value: instanceId }, { name: 'path', value: '/' }] },
];

let calls: string[];
let windows: string[];
let refuseIn: string | null;
let now = START;
let config: ConfigResult = CONFIG;

const READINGS: Record<string, number> = { c: 3.2, m: 24.4, d: 61 };

const aws: MetricsAws = {
  list: (_credentials, region, namespace, dimensions) => {
    calls.push(`list ${region} ${namespace} ${String(dimensions.length)}`);
    return Promise.resolve(region === 'us-east-1' ? agentMetrics('i-0abc') : [...agentMetrics('i-0def'), ...agentMetrics('i-0zzz')]);
  },
  data: (credentials, region, queries, from, to) => {
    calls.push(`data ${region} ${credentials.accessKeyId} ${queries.map((q) => `${q.id}/${String(q.periodSeconds)}`).join(' ')}`);
    windows.push(`${new Date(from).toISOString()} ${new Date(to).toISOString()}`);
    if (refuseIn === region) return Promise.reject(new AwsError('AccessDenied', 'no', 'cloudwatch:GetMetricData'));
    const points = (value: number): Point[] => [{ at: now - 600_000, value: 99 }, { at: now - 60_000, value }];
    return Promise.resolve(new Map(queries.map((q) => [q.id, points(READINGS[q.id.slice(0, 1)] ?? 0)])));
  },
  assume: (credentials, roleArn) => {
    calls.push(`assume ${roleArn} ${credentials.accessKeyId}`);
    return Promise.resolve({ accessKeyId: 'ASIATEMP', secretAccessKey: 's2', sessionToken: 't', expiresAt: now + 900_000 });
  },
  describe: () => Promise.reject(new Error('the summary never describes an instance')),
  associate: () => Promise.reject(new Error('the summary never gives a role')),
};

const deps: LatestApiDeps = {
  config: () => config,
  aws,
  now: () => now,
  rows: (owner) => Promise.resolve(ROWS[owner] ?? []),
  keys: new SigningKeys('http://127.0.0.1:1/nowhere'),
};

let server: Server;
let base = '';

beforeAll(async () => {
  deps.keys = await testKeys();
  server = createServer((req, res) => {
    if (handleLatestApiRequest(req, res, deps)) return;
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
  calls = [];
  windows = [];
  refuseIn = null;
  now = START;
  config = CONFIG;
  resetLatestCache();
  resetUsageState();
});

const latest = async (who = TEST_OWNER): Promise<{ status: number; servers: Record<string, unknown> }> => {
  const res = await fetch(`${base}/api/servers/usage`, { headers: { authorization: await auth(who, 'member') } });
  const body = (await res.json()) as { servers: Record<string, unknown> };
  return { status: res.status, servers: body.servers };
};

describe('the latest usage of every server, for the agent list', () => {
  test('an unsigned request is refused and AWS is never asked', async () => {
    expect((await fetch(`${base}/api/servers/usage`)).status).toBe(401);
    expect((await fetch(`${base}/api/servers/usage`, { method: 'POST' })).status).toBe(405);
    expect(calls).toEqual([]);
  });

  test('one list and one GetMetricData per region cover every server, and a server with no instance is left out', async () => {
    const answer = await latest();
    expect(answer.status).toBe(200);
    expect(answer.servers).toEqual({
      srv00000001: { cpu: 3.2, memory: 24.4, disk: 61 },
      srv00000002: { cpu: 3.2, memory: null, disk: null },
      srv00000003: { cpu: 3.2, memory: 24.4, disk: 61 },
    });
    expect(calls.sort()).toEqual([
      `assume ${ROLE} AKIAMETRO`,
      'data eu-central-2 ASIATEMP c0/300 m0/60 d0/60',
      'data us-east-1 AKIAMETRO c0/300 m0/60 d0/60 c1/300',
      'list eu-central-2 CWAgent 0',
      'list us-east-1 CWAgent 0',
    ]);
    expect(windows).toEqual(['2026-09-29T09:55:00.000Z 2026-09-29T10:10:00.000Z', '2026-09-29T09:55:00.000Z 2026-09-29T10:10:00.000Z']);
  });

  test('the answer is kept for a minute per organization', async () => {
    await latest();
    const first = calls.length;
    now = START + 59_000;
    await latest();
    expect(calls.length).toBe(first);
    expect(Object.keys((await latest(TEST_STRANGER)).servers)).toEqual(['srv00000009']);
    now = START + 61_000;
    calls = [];
    await latest();
    expect(calls.filter((c) => c.startsWith('data'))).toHaveLength(2);
  });

  test('a region AWS refuses shows no data for its servers only', async () => {
    refuseIn = 'us-east-1';
    const answer = await latest();
    expect(answer.status).toBe(200);
    expect(answer.servers.srv00000001).toEqual({ cpu: null, memory: null, disk: null });
    expect(answer.servers.srv00000003).toEqual({ cpu: 3.2, memory: 24.4, disk: 61 });
  });

  test('without an AWS account there is nothing to show and AWS is never asked', async () => {
    config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] };
    expect((await latest()).servers).toEqual({});
    expect(calls).toEqual([]);
  });
});
