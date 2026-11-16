import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_OWNER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, testDb, type TestDb } from './pglite-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const TAG = '0031_model_call_effort';
const BOX = 'agent000001';
const AT = Date.parse('2026-11-17T09:00:00.000Z');

let held: TestDb;

const COLUMNS = 'id, owner, agent, origin, lane, kind, model, attempt, outcome, status, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, ms, at';
const VALUES = `$1, '${TEST_OWNER}', '${BOX}', 'box', 'main', 'main', 'gpt-6.1-sol', 0, 'ok', 200, 1, 1, 0, 0, 0, 1, ${String(AT)}`;
const OLD_INSERT = `INSERT INTO model_calls (${COLUMNS}) VALUES (${VALUES})`;
const NEW_INSERT = `INSERT INTO model_calls (${COLUMNS}, effort) VALUES (${VALUES}, $2)`;

beforeAll(async () => {
  held = await testDb();
  await addAgent(held.db, BOX, TEST_OWNER);
}, PGLITE_START_MS);
afterAll(async () => {
  await held.close();
});

test('0031 is journaled after 0030', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const thirty = journal.entries.find((entry) => entry.idx === 30);
  const added = journal.entries.find((entry) => entry.idx === 31);
  expect(added).toMatchObject({ tag: TAG });
  expect(added?.when ?? 0).toBeGreaterThan(thirty?.when ?? Number.MAX_SAFE_INTEGER);
});

test('after 0031 the effort is an optional short word, and a writer that does not name it still records calls', async () => {
  const columns = await held.client.query<{ is_nullable: string; data_type: string }>("SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'model_calls' AND column_name = 'effort'");
  expect(columns.rows).toEqual([{ is_nullable: 'YES', data_type: 'text' }]);
  await held.client.query(OLD_INSERT, ['callold0001']);
  await held.client.query(NEW_INSERT, ['callnew0001', 'xhigh']);
  await expect(held.client.query(NEW_INSERT, ['callnew0002', 'x'.repeat(33)])).rejects.toThrow('model_calls_effort_check');
  const rows = await held.client.query<{ id: string; effort: string | null }>('SELECT id, effort FROM model_calls ORDER BY id');
  expect(rows.rows).toEqual([
    { id: 'callnew0001', effort: 'xhigh' },
    { id: 'callold0001', effort: null },
  ]);
});
