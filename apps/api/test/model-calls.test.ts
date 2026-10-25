import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { modelWindowsOf, recordModelCalls, saveModelWindows, type NewModelCall } from '@metro-labs/connectors/db/model-calls';
import { modelCalls } from '../src/db/schema.ts';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, addRemoteAgent, PGLITE_START_MS, testDb, type TestDb } from './pglite-db.ts';

const BOX = 'agent000001';
const REMOTE = 'remote00001';
const AT = Date.parse('2026-10-26T09:00:00.000Z');

let held: TestDb;

const call = (over: Partial<NewModelCall> = {}): NewModelCall => ({
  id: `call${String(Math.random()).slice(2, 9)}`,
  owner: TEST_OWNER,
  agent: BOX,
  origin: 'box',
  token: null,
  lane: 'main',
  kind: 'main',
  connection: 'conn0000001',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  attempt: 0,
  outcome: 'ok',
  status: 200,
  inputTokens: 12,
  outputTokens: 34,
  cacheReadTokens: 56_000,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 789,
  costMicros: 4_321,
  ms: 2_500,
  firstTokenMs: 700,
  at: AT,
  ...over,
});

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  await addAgent(held.db, BOX, TEST_OWNER);
  await addRemoteAgent(held.db, REMOTE, TEST_OWNER, 'Dashboard');
});
afterAll(async () => {
  await held.close();
});

describe('model calls', () => {
  test('a batch is written with the name each agent had at that moment, and nothing for an empty batch', async () => {
    await recordModelCalls(held.db, []);
    await recordModelCalls(held.db, [call(), call({ agent: REMOTE, origin: 'key', token: 'tok00000001', lane: 'workers', kind: 'external', costMicros: null, firstTokenMs: null })]);
    const rows = await held.db.select().from(modelCalls).orderBy(modelCalls.agent);
    expect(rows.map((row) => [row.agent, row.agentName, row.origin, row.token])).toEqual([
      [BOX, 'agent000001.tail0000.ts.net', 'box', null],
      [REMOTE, 'Dashboard', 'key', 'tok00000001'],
    ]);
    expect(rows[0]).toMatchObject({ cacheReadTokens: 56_000, cacheWrite1hTokens: 789, costMicros: 4_321, firstTokenMs: 700 });
  });

  test('the database refuses a key call without its key, a box call with one, and an unknown lane', async () => {
    await expect(recordModelCalls(held.db, [call({ origin: 'key', token: null })])).rejects.toThrow();
    await expect(recordModelCalls(held.db, [call({ origin: 'box', token: 'tok00000001' })])).rejects.toThrow();
    await expect(recordModelCalls(held.db, [call({ lane: 'helpers' })])).rejects.toThrow();
    await expect(recordModelCalls(held.db, [call({ inputTokens: -1 })])).rejects.toThrow();
  });
});

describe('model usage windows', () => {
  test('a save replaces the windows of that connection and leaves other connections and owners alone', async () => {
    await saveModelWindows(held.db, TEST_OWNER, 'conn0000001', [{ label: '5 hours', used: 0.4, resetAt: AT + 1, detail: null }, { label: 'Weekly, all models', used: 0.1, resetAt: null, detail: null }], AT);
    await saveModelWindows(held.db, TEST_OWNER, 'conn0000002', [{ label: '5 hours', used: 0.9, resetAt: null, detail: 'key limit' }], AT);
    await saveModelWindows(held.db, TEST_STRANGER, 'conn0000009', [{ label: '5 hours', used: 1, resetAt: null, detail: null }], AT);
    await saveModelWindows(held.db, TEST_OWNER, 'conn0000001', [{ label: '5 hours', used: 0.6, resetAt: AT + 2, detail: null }], AT + 5);
    const mine = (await modelWindowsOf(held.db, TEST_OWNER)).map((w) => [w.connection, w.label, Math.round((w.used ?? 0) * 100), w.at]).sort();
    expect(mine).toEqual([
      ['conn0000001', '5 hours', 60, AT + 5],
      ['conn0000002', '5 hours', 90, AT],
    ]);
    await saveModelWindows(held.db, TEST_OWNER, 'conn0000002', [], AT + 9);
    expect((await modelWindowsOf(held.db, TEST_OWNER)).map((w) => w.connection)).toEqual(['conn0000001']);
    expect(await modelWindowsOf(held.db, TEST_STRANGER)).toHaveLength(1);
  });
});
