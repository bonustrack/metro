import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../src/db/auth-sessions.ts';
import { users } from '../src/db/schema.ts';
import { PGLITE_START_MS, testDb, type TestDb } from './pglite-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const ANA = 'user_01ANA';
const AT = Date.parse('2026-11-17T09:00:00.000Z');

let held: TestDb;

const sessionId = (n: number): string => `session_01KBZ0000000000000000000${String(n).padStart(2, '0')}`;
const hashOf = (n: number): string => `${'c'.repeat(42)}${String(n)}`;
const INSERT = 'INSERT INTO auth_sessions (id, user_id, method, refresh_hash, created_at, last_used_at, expires_at) VALUES ($1, $2, $3, $4, $5, $5, $5)';

beforeAll(async () => {
  held = await testDb();
  await held.db.insert(users).values({ id: ANA, email: 'ana@example.com', updatedAt: 'x' });
}, PGLITE_START_MS);
afterAll(async () => {
  await held.close();
});

test('0032 and 0033 are journaled in order after 0031', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const at = (idx: number) => journal.entries.find((entry) => entry.idx === idx);
  expect(at(32)).toMatchObject({ tag: '0032_drop_login_links' });
  expect(at(33)).toMatchObject({ tag: '0033_drop_session_link' });
  expect(at(32)?.when ?? 0).toBeGreaterThan(at(31)?.when ?? Number.MAX_SAFE_INTEGER);
  expect(at(33)?.when ?? 0).toBeGreaterThan(at(32)?.when ?? Number.MAX_SAFE_INTEGER);
});

test('login_links and auth_sessions.link are gone, and no session can be made by a login link', async () => {
  const tables = await held.client.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'login_links'");
  expect(tables.rows).toEqual([]);
  const columns = await held.client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'auth_sessions' AND column_name = 'link'");
  expect(columns.rows).toEqual([]);
  const indexes = await held.client.query("SELECT 1 FROM pg_indexes WHERE indexname = 'auth_sessions_link_idx'");
  expect(indexes.rows).toEqual([]);
  await expect(held.client.query(INSERT, [sessionId(1), ANA, 'link', hashOf(1), AT])).rejects.toThrow('auth_sessions_method_check');
});

test('sessions from Google, Microsoft and the move from WorkOS still fit, and the store still makes one', async () => {
  const methods = ['google', 'microsoft', 'workos'];
  for (const [i, method] of methods.entries()) await held.client.query(INSERT, [sessionId(i + 2), ANA, method, hashOf(i + 2), AT]);
  const made = await createSession(held.db, { user: ANA, method: 'google', now: AT });
  expect(made.session).toMatchObject({ user: ANA, method: 'google' });
  const rows = await held.client.query<{ method: string }>('SELECT method FROM auth_sessions ORDER BY method');
  expect(rows.rows.map((row) => row.method)).toEqual(['google', 'google', 'microsoft', 'workos']);
});
