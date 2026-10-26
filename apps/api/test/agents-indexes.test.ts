import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLITE_START_MS, testDb, type TestDb } from './pglite-db.ts';

let held: TestDb;

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);

afterAll(async () => {
  await held.close();
});

test('0022 drops the owner index of agents, which the owner and host and owner and slug indexes already cover', async () => {
  const rows = await held.client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'agents' ORDER BY indexname");
  const names = rows.rows.map((row) => row.indexname);
  expect(names).not.toContain('agents_owner_idx');
  expect(names).toEqual(expect.arrayContaining(['agents_owner_host_idx', 'agents_owner_slug_idx']));
});
