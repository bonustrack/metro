/**
 * The two live numbers behind the dashboard, carried on the same route and the
 * same credential the runs already use. They are REPORTED, not derived: nothing
 * here recomputes them from `agent_runs`, because that table has no queue at all
 * and its `running` is a snapshot between pushes. What the daemon owes the panel
 * is the number it was told and the moment it was told, so a reader can see for
 * itself whether anyone is still reporting.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { setAgentRunsBackend } from '../src/daemon/agent-runs-api.ts';
import { signSession } from '../src/daemon/session.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import type { AgentReportRow } from '../src/db/agent-report.ts';
import type { ReportRow } from '../src/db/schema.ts';

const ONE = 'mk_counts_one';
const TWO = 'mk_counts_two';
const SECRET = 'agent-counts-test-secret';

let server: Server;
let base: string;
let counted: { agentId: number; rows: ReportRow[] }[] = [];
let rows: AgentReportRow[] = [];

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
    recordRuns: () => Promise.resolve(0),
    listRuns: () => Promise.resolve([]),
    recordReport: (agentId, reported) => {
      counted.push({ agentId, rows: reported });
      return Promise.resolve();
    },
    listReports: (allowed) =>
      Promise.resolve(rows.filter((r) => allowed.has(r.agentId))),
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
  counted = [];
  rows = [];
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

const get = (token?: string): Promise<Response> =>
  fetch(`${base}/api/agent-runs`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const row = (agentId: number, rows: ReportRow[]): AgentReportRow => ({
  agentId,
  rows,
  reportedAt: new Date('2026-08-14T04:00:00.000Z'),
});

const agentRow = (over: Partial<ReportRow> = {}): Record<string, unknown> => ({
  kind: 'agent',
  id: 'a4f4a74',
  state: 'run',
  label: 'Rebase the open branches',
  started_at: '2026-08-14T04:35:48.000Z',
  ...over,
});

describe('reporting rows', () => {
  test('an agent key files the rows against that agent and nobody else', async () => {
    const res = await post({ report: [agentRow()] }, ONE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 0, report: 1 });
    expect(counted).toHaveLength(1);
    expect(counted[0]?.agentId).toBe(1);
    expect(counted[0]?.rows[0]?.id).toBe('a4f4a74');
    expect(counted[0]?.rows[0]?.label).toBe('Rebase the open branches');
  });

  test('a queue row carries who, needs and the blocker', async () => {
    await post(
      {
        report: [
          {
            kind: 'queue',
            id: 'q1',
            state: 'blocked',
            label: 'Check the gating',
            who: 'someone',
            needs: ['repo:one', 'repo:two'],
            blocked_on: 'a go-ahead',
            started_at: '2026-08-14T07:07:45.000Z',
          },
        ],
      },
      ONE,
    );
    const stored = counted[0]?.rows[0];
    expect(stored?.kind).toBe('queue');
    expect(stored?.who).toBe('someone');
    expect(stored?.needs).toEqual(['repo:one', 'repo:two']);
    expect(stored?.blockedOn).toBe('a go-ahead');
  });

  test('a push with no report leaves the stored report alone', async () => {
    const res = await post({ runs: [] }, ONE);
    expect(await res.json()).toEqual({ stored: 0, report: null });
    expect(counted).toEqual([]);
  });

  test('an empty report is a real report, not a missing one', async () => {
    const res = await post({ report: [] }, ONE);
    expect(await res.json()).toEqual({ stored: 0, report: 0 });
    expect(counted).toEqual([{ agentId: 1, rows: [] }]);
  });

  test('free text is flattened and truncated at the server, not trusted', async () => {
    await post(
      { report: [agentRow({ label: `a\u0000b\n\nc   d${'x'.repeat(200)}` })] },
      ONE,
    );
    const label = counted[0]?.rows[0]?.label ?? '';
    expect(label).not.toContain('\u0000');
    expect(label).not.toContain('\n');
    expect(label.length).toBeLessThanOrEqual(120);
  });

  test('rows with no credential are refused and never reach the store', async () => {
    expect((await post({ report: [agentRow()] })).status).toBe(401);
    expect(counted).toEqual([]);
  });

  test('a session covering several agents must name the owning agent', async () => {
    const token = signSession({ email: 'a@b.c', agentIds: [1, 2] }, SECRET);
    expect((await post({ report: [agentRow()] }, token)).status).toBe(400);
    const named = await post({ report: [agentRow()] }, token, '?agent=2');
    expect(named.status).toBe(200);
    expect(counted[0]?.agentId).toBe(2);
  });

  test('a malformed report is refused whole, with a reason', async () => {
    const cases: [unknown, string][] = [
      [{ report: 'nope' }, 'report must be an array'],
      [{ report: [{ id: 'a1', state: 'run' }] }, 'kind must be one of'],
      [{ report: [agentRow({ kind: 'other' })] }, 'kind must be one of'],
      [{ report: [agentRow({ started_at: 'not a date' })] }, 'must be a timestamp'],
      [{ report: [agentRow({ needs: 'nope' })] }, 'needs must be an array'],
    ];
    for (const [body, reason] of cases) {
      const res = await post(body, ONE);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(reason);
    }
    expect(counted).toEqual([]);
  });

  test('a report bigger than the cap is refused rather than half-stored', async () => {
    const many = Array.from({ length: 201 }, () => agentRow());
    const res = await post({ report: many }, ONE);
    expect(res.status).toBe(400);
    expect(counted).toEqual([]);
  });
});

describe('reading the report back', () => {
  const stored: ReportRow = {
    kind: 'agent',
    id: 'a4f4a74',
    state: 'run',
    label: 'a label',
    who: null,
    needs: [],
    blockedOn: null,
    startedAt: '2026-08-14T04:35:48.000Z',
    endedAt: null,
  };

  test('a caller only ever sees the report of the agents it covers', async () => {
    rows = [row(1, [stored]), row(2, [{ ...stored, id: 'bbbbbbb' }])];
    const body = (await (await get(ONE)).json()) as {
      reports: Record<string, unknown>[];
    };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]?.agent_id).toBe(1);
  });

  test('the moment of the report goes out with it, so staleness is visible', async () => {
    rows = [row(1, [stored])];
    const body = (await (await get(ONE)).json()) as {
      reports: { reported_at: string }[];
    };
    expect(body.reports[0]?.reported_at).toBe('2026-08-14T04:00:00.000Z');
  });

  test('a row goes out in the same shape the reporter sent', async () => {
    rows = [row(1, [stored])];
    const body = (await (await get(ONE)).json()) as {
      reports: { rows: Record<string, unknown>[] }[];
    };
    expect(body.reports[0]?.rows[0]).toEqual({
      kind: 'agent',
      id: 'a4f4a74',
      state: 'run',
      label: 'a label',
      who: null,
      needs: [],
      blocked_on: null,
      started_at: '2026-08-14T04:35:48.000Z',
      ended_at: null,
    });
  });

  test('an agent that has never reported is simply absent', async () => {
    rows = [];
    const body = (await (await get(ONE)).json()) as { reports: unknown[] };
    expect(body.reports).toEqual([]);
  });

  test('no credential reads nothing', async () => {
    rows = [row(1, [stored])];
    expect((await get()).status).toBe(401);
  });
});
