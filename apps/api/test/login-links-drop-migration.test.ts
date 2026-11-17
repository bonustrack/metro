import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { users } from '../src/db/schema.ts';
import { PGLITE_START_MS, testDb, type TestDb } from './pglite-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const TAG = '0032_drop_login_links';
const ANA = 'user_01ANA';
const AT = Date.parse('2026-11-17T09:00:00.000Z');
const HASH = 'a'.repeat(43);

let held: TestDb;

const sessionId = (n: number): string => `session_01KBZ0000000000000000000${String(n).padStart(2, '0')}`;
const OLD_INSERT = 'INSERT INTO auth_sessions (id, user_id, method, refresh_hash, created_at, last_used_at, expires_at, link) VALUES ($1, $2, $3, $4, $5, $5, $5, NULL)';

beforeAll(async () => {
  held = await testDb();
  await held.db.insert(users).values({ id: ANA, email: 'ana@example.com', updatedAt: 'x' });
}, PGLITE_START_MS);
afterAll(async () => {
  await held.close();
});

test('0032 is journaled after 0031', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const before = journal.entries.find((entry) => entry.idx === 31);
  const added = journal.entries.find((entry) => entry.idx === 32);
  expect(added).toMatchObject({ tag: TAG });
  expect(added?.when ?? 0).toBeGreaterThan(before?.when ?? Number.MAX_SAFE_INTEGER);
});

test('after 0032 login_links is gone and no session can be made by a login link', async () => {
  const tables = await held.client.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'login_links'");
  expect(tables.rows).toEqual([]);
  await expect(held.client.query(OLD_INSERT, [sessionId(1), ANA, 'link', HASH.replace(/^a/, 'b'), AT])).rejects.toThrow('auth_sessions_method_check');
});

test('after 0032 sessions from Google, Microsoft and the move from WorkOS still fit, also from a writer that still names link', async () => {
  const methods = ['google', 'microsoft', 'workos'];
  for (const [i, method] of methods.entries()) await held.client.query(OLD_INSERT, [sessionId(i + 2), ANA, method, `${'c'.repeat(42)}${String(i)}`, AT]);
  const rows = await held.client.query<{ method: string }>('SELECT method FROM auth_sessions ORDER BY method');
  expect(rows.rows.map((row) => row.method)).toEqual(methods);
});
