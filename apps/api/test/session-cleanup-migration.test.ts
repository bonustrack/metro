import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createSession } from '../src/db/auth-sessions.ts';
import * as schema from '../src/db/schema.ts';
import { users } from '../src/db/schema.ts';
import { PGLITE_START_MS, testDb, type TestDb } from './pglite-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const ANA = 'user_01ANA';
const BEN = 'user_01BEN';
const AT = Date.parse('2026-11-17T09:00:00.000Z');

let held: TestDb;

const sessionId = (n: number): string => `session_01KBZ0000000000000000000${String(n).padStart(2, '0')}`;
const hashOf = (n: number): string => `${'c'.repeat(42)}${String(n)}`;
const spentOf = (n: number): string => `${'d'.repeat(42)}${String(n)}`;
const INSERT = 'INSERT INTO auth_sessions (id, user_id, method, refresh_hash, created_at, last_used_at, expires_at) VALUES ($1, $2, $3, $4, $5, $5, $5)';

function through(dir: string, last: number): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(path, JSON.stringify(journal));
}

beforeAll(async () => {
  held = await testDb();
  await held.db.insert(users).values({ id: ANA, email: 'ana@example.com', updatedAt: 'x' });
}, PGLITE_START_MS);
afterAll(async () => {
  await held.close();
});

test('0032 to 0035 are journaled in order after 0031, the WorkOS cleanup after the chats', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const at = (idx: number) => journal.entries.find((entry) => entry.idx === idx);
  expect(at(32)).toMatchObject({ tag: '0032_drop_login_links' });
  expect(at(33)).toMatchObject({ tag: '0033_drop_session_link' });
  expect(at(34)).toMatchObject({ tag: '0034_chats' });
  expect(at(35)).toMatchObject({ tag: '0035_drop_workos_sessions' });
  for (const idx of [32, 33, 34, 35]) expect(at(idx)?.when ?? 0).toBeGreaterThan(at(idx - 1)?.when ?? Number.MAX_SAFE_INTEGER);
});

test('login_links and auth_sessions.link are gone, and no session can be made by a login link or WorkOS', async () => {
  const tables = await held.client.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'login_links'");
  expect(tables.rows).toEqual([]);
  const columns = await held.client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'auth_sessions' AND column_name = 'link'");
  expect(columns.rows).toEqual([]);
  const indexes = await held.client.query("SELECT 1 FROM pg_indexes WHERE indexname = 'auth_sessions_link_idx'");
  expect(indexes.rows).toEqual([]);
  await expect(held.client.query(INSERT, [sessionId(1), ANA, 'link', hashOf(1), AT])).rejects.toThrow('auth_sessions_method_check');
  await expect(held.client.query(INSERT, [sessionId(2), ANA, 'workos', hashOf(2), AT])).rejects.toThrow('auth_sessions_method_check');
});

test('sessions from Google and Microsoft still fit, and the store still makes one', async () => {
  for (const [i, method] of ['google', 'microsoft'].entries()) await held.client.query(INSERT, [sessionId(i + 3), ANA, method, hashOf(i + 3), AT]);
  const made = await createSession(held.db, { user: ANA, method: 'google', now: AT });
  expect(made.session).toMatchObject({ user: ANA, method: 'google' });
  const rows = await held.client.query<{ method: string }>('SELECT method FROM auth_sessions ORDER BY method');
  expect(rows.rows.map((row) => row.method)).toEqual(['google', 'google', 'microsoft']);
});

test('0035 deletes only the sessions moved over from WorkOS, with their spent tokens', async () => {
  const before = mkdtempSync(join(tmpdir(), 'metro-workos-sessions-34-'));
  const after = mkdtempSync(join(tmpdir(), 'metro-workos-sessions-35-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    through(before, 34);
    through(after, 35);
    await migrate(db, { migrationsFolder: before });
    for (const [id, email] of [[ANA, 'ana@example.com'], [BEN, 'ben@example.com']] as const) await client.query("INSERT INTO users (id, email, updated_at) VALUES ($1, $2, 'x')", [id, email]);
    const seeded: [number, string, string][] = [[1, ANA, 'workos'], [2, ANA, 'google'], [3, BEN, 'workos'], [4, BEN, 'microsoft']];
    for (const [n, user, method] of seeded) await client.query(INSERT, [sessionId(n), user, method, hashOf(n), AT]);
    for (const n of [1, 2]) await client.query('INSERT INTO auth_spent_tokens (hash, session, spent_at) VALUES ($1, $2, $3)', [spentOf(n), sessionId(n), AT]);

    await migrate(db, { migrationsFolder: after });
    const sessions = await client.query<{ id: string; method: string }>('SELECT id, method FROM auth_sessions ORDER BY id');
    expect(sessions.rows).toEqual([{ id: sessionId(2), method: 'google' }, { id: sessionId(4), method: 'microsoft' }]);
    const spent = await client.query<{ hash: string }>('SELECT hash FROM auth_spent_tokens ORDER BY hash');
    expect(spent.rows).toEqual([{ hash: spentOf(2) }]);
    const people = await client.query<{ id: string }>('SELECT id FROM users ORDER BY id');
    expect(people.rows.map((row) => row.id)).toEqual([ANA, BEN]);
    await expect(client.query(INSERT, [sessionId(5), BEN, 'workos', hashOf(5), AT])).rejects.toThrow('auth_sessions_method_check');
  } finally {
    await client.close();
    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
