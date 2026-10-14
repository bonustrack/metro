import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import { mcpApprovals } from '@metro-labs/connectors/db/schema';
import { APPROVAL_KEEP_MS, approvalStore, pruneApprovals, type ApprovalRow } from '../src/approvals.ts';
import { argsDigest, previewOf } from '../src/digest.ts';
import { pruneOnce, startApprovalPruning } from '../src/prune.ts';
import { enrollAgent, PGLITE_START_MS, testDb, type TestAgent, type TestDb } from './helpers.ts';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

let held: TestDb;
let agent: TestAgent;

function row(id: string, state: string, requestedAt: number, answeredAt: number | null): ApprovalRow {
  return { id, owner: agent.row.owner, agent: agent.row.agent, connector: 'conn0000001', tool: 'update_page', argsDigest: argsDigest({ id }), preview: previewOf({ id }), state, requestedAt, answeredAt, deliveredAt: null };
}

const ids = async (): Promise<string[]> => (await held.db.select({ id: mcpApprovals.id }).from(mcpApprovals)).map((r) => r.id).sort();

const until = async (done: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 200 && !(await done()); i += 1) await Bun.sleep(10);
};

beforeAll(async () => { held = await testDb(); }, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  agent = await enrollAgent(held.db, 'agent000001');
});
afterAll(async () => { await held.close(); });

describe('pruning answered approvals', () => {
  test('a settled row older than 7 days goes, a pending row never answered goes 8 days after its request, recent rows stay', async () => {
    await held.db.insert(mcpApprovals).values([
      row('aaaaa', 'allow', NOW - 9 * DAY, NOW - 8 * DAY),
      row('bbbbb', 'deny', NOW - 9 * DAY, NOW - 8 * DAY),
      row('ccccc', 'used', NOW - 9 * DAY, NOW - 8 * DAY),
      row('ddddd', 'expired', NOW - 9 * DAY, NOW - 8 * DAY),
      row('eeeee', 'deny', NOW - 8 * DAY, null),
      row('fffff', 'allow', NOW - 9 * DAY, NOW - 6 * DAY),
      row('ggggg', 'expired', NOW - 30 * DAY, NOW - 6 * DAY),
      row('hhhhh', 'used', NOW - 8 * DAY, NOW - APPROVAL_KEEP_MS),
      row('iiiii', 'pending', NOW - 30 * DAY, null),
      row('jjjjj', 'deny', NOW - 6 * DAY, null),
      row('kkkkk', 'pending', NOW - 7 * DAY, null),
    ]);
    expect(await pruneApprovals(held.db, NOW)).toBe(6);
    expect(await ids()).toEqual(['fffff', 'ggggg', 'hhhhh', 'jjjjj', 'kkkkk']);
    expect(await pruneApprovals(held.db, NOW)).toBe(0);
  });

  test('an expired request is kept 7 days after it expired, then goes', async () => {
    const store = approvalStore(() => held.db);
    const call = { connector: 'conn0000001', tool: 'update_page', digest: argsDigest({ page: 1 }), preview: previewOf({ page: 1 }) };
    const id = await store.request(agent.row, call, NOW);
    expect(await store.deliver(agent.row, NOW + DAY + 1)).toEqual([]);
    expect(await pruneApprovals(held.db, NOW + DAY + 1 + APPROVAL_KEEP_MS)).toBe(0);
    expect(await ids()).toEqual([id]);
    expect(await pruneApprovals(held.db, NOW + DAY + 2 + APPROVAL_KEEP_MS)).toBe(1);
    expect(await ids()).toEqual([]);
  });

  test('two machines pruning at once both finish and remove each row once', async () => {
    await held.db.insert(mcpApprovals).values(['kkkkk', 'mmmmm', 'nnnnn', 'ppppp'].map((id) => row(id, 'deny', NOW - 9 * DAY, NOW - 8 * DAY)));
    const counts = await Promise.all([pruneApprovals(held.db, NOW), pruneApprovals(held.db, NOW)]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(await ids()).toEqual([]);
  });
});

describe('the pruning timer', () => {
  test('it prunes at start and then on its interval, with one info line per run', async () => {
    await held.db.insert(mcpApprovals).values(row('qqqqq', 'used', NOW - 9 * DAY, NOW - 8 * DAY));
    const info = spyOn(log, 'info');
    const stop = startApprovalPruning(() => held.db, () => NOW, 25);
    try {
      await until(async () => (await ids()).length === 0);
      expect(await ids()).toEqual([]);
      await held.db.insert(mcpApprovals).values(row('rrrrr', 'deny', NOW - 9 * DAY, NOW - 8 * DAY));
      await until(async () => (await ids()).length === 0);
      expect(await ids()).toEqual([]);
      const lines = info.mock.calls.filter((call) => call[1] === 'mcp: removed answered approvals older than 7 days');
      expect(lines.some((call) => JSON.stringify(call[0]) === '{"removed":1}')).toBe(true);
    } finally {
      stop();
      info.mockRestore();
    }
  });

  test('a database failure is logged and never thrown', async () => {
    const warn = spyOn(log, 'warn');
    const broken = (): Database => { throw new Error('database down'); };
    try {
      expect(await pruneOnce(broken, () => NOW)).toBeNull();
      const stop = startApprovalPruning(broken, () => NOW, 25);
      await until(() => Promise.resolve(warn.mock.calls.length >= 3));
      stop();
      expect(warn.mock.calls.every((call) => call[1] === 'mcp: could not remove old approvals')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
