import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { setAgentRunsBackend } from '../src/daemon/agent-runs-api.ts';
import { signSession } from '../src/daemon/session.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import type { AgentRunInput, AgentRunRow } from '../src/db/agent-runs.ts';
import type { AgentReportRow } from '../src/db/agent-report.ts';
import type { ReportRow } from '../src/db/schema.ts';

const ONE = 'mk_runs_one';
const TWO = 'mk_runs_two';
const SECRET = 'agent-runs-test-secret';

let server: Server;
let base: string;
let stored: { agentId: number; runs: AgentRunInput[] }[] = [];
let listed: { allowed: number[]; sinceMs: number; limit: number }[] = [];
let rows: AgentRunRow[] = [];
let counted: { agentId: number; rows: ReportRow[] }[] = [];
let countRows: AgentReportRow[] = [];

const RUN = {
  id: 'a6494ae6dcf34b8de',
  type: 'worker',
  label: 'Rebase the open PRs',
  state: 'running',
  started_at: '2026-08-14T04:35:48.000Z',
  turns: 7,
  input_tokens: 12,
  output_tokens: 4200,
  cache_read_tokens: 910_000,
  cache_write_tokens: 24_000,
};

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  setKeyMap([
    { key: ONE, agentId: 1 },
    { key: TWO, agentId: 2 },
  ]);
  setAgentRunsBackend({
    recordRuns: (agentId, runs) => {
      stored.push({ agentId, runs });
      return Promise.resolve(runs.length);
    },
    listRuns: (allowed, sinceMs, limit) => {
      listed.push({ allowed: [...allowed], sinceMs, limit });
      return Promise.resolve(rows.filter((r) => allowed.has(r.agentId)));
    },
    recordReport: (agentId, reported) => {
      counted.push({ agentId, rows: reported });
      return Promise.resolve();
    },
    listReports: (allowed) =>
      Promise.resolve(countRows.filter((r) => allowed.has(r.agentId))),
  });
  server = await startWebhookServer(makeEmit(), undefined, () =>
    Promise.resolve({ result: null }),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setKeyMap([]);
  setAgentRunsBackend(null);
  delete process.env.METRO_SESSION_SECRET;
});

beforeEach(() => {
  stored = [];
  listed = [];
  rows = [];
  counted = [];
  countRows = [];
});

const post = (body: unknown, token?: string, query = ''): Promise<Response> =>
  fetch(`${base}/api/agent-runs${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const get = (token?: string, query = ''): Promise<Response> =>
  fetch(`${base}/api/agent-runs${query}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const row = (agentId: number, runId: string): AgentRunRow => ({
  agentId,
  runId,
  agentType: 'worker',
  label: 'a label',
  state: 'done',
  startedAt: new Date('2026-08-14T04:00:00.000Z'),
  endedAt: new Date('2026-08-14T04:05:00.000Z'),
  turns: 3,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
});

describe('pushing runs', () => {
  test('an agent key stores runs against that agent and nobody else', async () => {
    const res = await post({ runs: [RUN] }, ONE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 1, report: null });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.agentId).toBe(1);
    expect(stored[0]?.runs[0]?.runId).toBe(RUN.id);
    expect(stored[0]?.runs[0]?.startedAt.toISOString()).toBe(RUN.started_at);
  });

  test('a run with no credential is refused and never reaches the store', async () => {
    expect((await post({ runs: [RUN] })).status).toBe(401);
    expect((await post({ runs: [RUN] }, 'mk_not_a_key')).status).toBe(401);
    expect(stored).toEqual([]);
  });

  test('a session covering several agents must name the owning agent', async () => {
    const token = signSession(
      { email: 'ada@lovelace.dev', agentIds: [1, 2] },
      SECRET,
    );
    expect((await post({ runs: [RUN] }, token)).status).toBe(400);
    const named = await post({ runs: [RUN] }, token, '?agent=2');
    expect(named.status).toBe(200);
    expect(stored[0]?.agentId).toBe(2);
  });

  test('an agent outside the scope cannot be named as the owner', async () => {
    const res = await post({ runs: [RUN] }, ONE, '?agent=2');
    expect(res.status).toBe(403);
    expect(stored).toEqual([]);
  });

  test('a running run never carries an end, whatever the pusher claims', async () => {
    await post(
      { runs: [{ ...RUN, ended_at: '2026-08-14T05:00:00.000Z' }] },
      ONE,
    );
    expect(stored[0]?.runs[0]?.endedAt).toBeNull();
  });

  test('the label is truncated and stripped at the server, not trusted', async () => {
    const long = `${'x'.repeat(200)}\nsecond line`;
    await post({ runs: [{ ...RUN, label: long }] }, ONE);
    const label = stored[0]?.runs[0]?.label ?? '';
    expect(label.length).toBe(80);
    expect(label).not.toContain('\n');
    expect(label.endsWith('…')).toBe(true);
  });

  test('a blank label lands as no label at all', async () => {
    await post({ runs: [{ ...RUN, label: '   ' }] }, ONE);
    expect(stored[0]?.runs[0]?.label).toBeNull();
  });

  test('a malformed run is refused whole, with a reason', async () => {
    const cases: [unknown, string][] = [
      [{ runs: 'nope' }, 'runs must be an array'],
      [{ runs: [{ ...RUN, id: '../etc/passwd' }] }, 'id is not valid'],
      [{ runs: [{ ...RUN, state: 'busy' }] }, 'state must be one of'],
      [{ runs: [{ ...RUN, started_at: 'yesterday' }] }, 'started_at must be'],
      [{ runs: [{ ...RUN, turns: -3 }] }, 'turns must be'],
      [{ runs: [{ ...RUN, output_tokens: 'lots' }] }, 'output_tokens must be'],
      [
        {
          runs: [
            {
              ...RUN,
              state: 'done',
              ended_at: '2020-01-01T00:00:00.000Z',
            },
          ],
        },
        'ended_at is before started_at',
      ],
    ];
    for (const [body, reason] of cases) {
      const res = await post(body, ONE);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(reason);
    }
    expect(stored).toEqual([]);
  });

  test('a batch bigger than the cap is refused rather than half-stored', async () => {
    const res = await post({ runs: new Array(201).fill(RUN) }, ONE);
    expect(res.status).toBe(400);
    expect(stored).toEqual([]);
  });
});

describe('reading runs back', () => {
  test('a session only ever sees the runs of the agents it covers', async () => {
    rows = [row(1, 'a1'), row(2, 'b1')];
    const res = await get(ONE);
    const body = (await res.json()) as { runs: { agent_id: number }[] };
    expect(res.status).toBe(200);
    expect(body.runs.map((r) => r.agent_id)).toEqual([1]);
    expect(listed[0]?.allowed).toEqual([1]);
  });

  test('the window is fourteen days unless a caller asks for another', async () => {
    await get(ONE);
    expect(listed[0]?.sinceMs).toBe(14 * 24 * 60 * 60 * 1000);
    await get(ONE, '?days=3');
    expect(listed[1]?.sinceMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect((await get(ONE, '?days=900')).status).toBe(400);
    expect((await get(ONE, '?days=0')).status).toBe(400);
  });

  test('a row goes out in the same shape the pusher sends', async () => {
    rows = [row(1, 'a1')];
    const body = (await (await get(ONE)).json()) as {
      runs: Record<string, unknown>[];
    };
    expect(Object.keys(body.runs[0] ?? {}).sort()).toEqual([
      'agent_id',
      'cache_read_tokens',
      'cache_write_tokens',
      'ended_at',
      'id',
      'input_tokens',
      'label',
      'output_tokens',
      'started_at',
      'state',
      'turns',
      'type',
    ]);
  });

  test('no credential reads nothing', async () => {
    rows = [row(1, 'a1')];
    expect((await get()).status).toBe(401);
    expect(listed).toEqual([]);
  });
});

describe('the route surface', () => {
  test('only GET and POST are answered', async () => {
    const res = await fetch(`${base}/api/agent-runs`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ONE}` },
    });
    expect(res.status).toBe(405);
  });

  test('anything under the prefix is a 404 from this handler', async () => {
    const res = await get(ONE, '/1');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain(
      'agent-runs',
    );
  });

  test('preflight is answered without a credential', async () => {
    const res = await fetch(`${base}/api/agent-runs`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});
