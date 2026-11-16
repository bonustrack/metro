import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { noteLoginIn } from '../src/db/users.ts';
import * as schema from '../src/db/schema.ts';
import { PGLITE_START_MS } from './pglite-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const OLD_USER = 'INSERT INTO users (id, email, updated_at, last_login_at) VALUES ($1, $2, $3, $4)';

function through(dir: string, last: number): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(path, JSON.stringify(journal));
}

test('0028 is journaled after 0027', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const before = journal.entries.find((entry) => entry.idx === 27);
  const added = journal.entries.find((entry) => entry.idx === 28);
  expect(added).toMatchObject({ tag: '0028_own_accounts' });
  expect(added?.when ?? 0).toBeGreaterThan(before?.when ?? Number.MAX_SAFE_INTEGER);
});

test('0028 keeps a shared email on the row that logged in last, then refuses a second row with it', async () => {
  const before = mkdtempSync(join(tmpdir(), 'metro-own-accounts-before-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    through(before, 27);
    await migrate(db, { migrationsFolder: before });
    await client.query(OLD_USER, ['user_01OLD', 'Ana@Example.com', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    await client.query(OLD_USER, ['user_02NEW', 'ana@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    await client.query(OLD_USER, ['user_03NONE', null, '2026-10-01T00:00:00.000Z', null]);
    await client.query("INSERT INTO organizations (id, slug, created_at, updated_at) VALUES ('org_01TESTORG00', 'stage-labs', 'x', 'x')");
    await migrate(db, { migrationsFolder: DIR });
    const rows = (await client.query<{ id: string; email: string | null }>('SELECT id, email FROM users ORDER BY id')).rows;
    expect(rows).toEqual([
      { id: 'user_01OLD', email: null },
      { id: 'user_02NEW', email: 'ana@example.com' },
      { id: 'user_03NONE', email: null },
    ]);
    expect((await client.query<{ name: string | null }>("SELECT name FROM organizations WHERE id = 'org_01TESTORG00'")).rows).toEqual([{ name: null }]);
    await expect(client.query(OLD_USER, ['user_04DUP', 'ANA@example.com', 'x', null])).rejects.toThrow();
  } finally {
    rmSync(before, { recursive: true, force: true });
    await client.close();
  }
}, PGLITE_START_MS);

test('a login whose email another row holds is still noted, without the email', async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    await migrate(db, { migrationsFolder: DIR });
    await client.query(OLD_USER, ['user_01INVITED', 'ana@example.com', 'x', null]);
    await noteLoginIn(db, { id: 'user_02WORKOS', email: 'ana@example.com', name: 'Ana', picture: null, createdAt: null }, '2026-11-16T09:00:00.000Z');
    await noteLoginIn(db, { id: 'user_03OTHER', email: 'bo@example.com', name: 'Bo', picture: null, createdAt: null }, '2026-11-16T09:00:00.000Z');
    const rows = (await client.query<{ id: string; email: string | null; name: string | null; last_login_at: string | null }>('SELECT id, email, name, last_login_at FROM users ORDER BY id')).rows;
    expect(rows).toEqual([
      { id: 'user_01INVITED', email: 'ana@example.com', name: null, last_login_at: null },
      { id: 'user_02WORKOS', email: null, name: 'Ana', last_login_at: '2026-11-16T09:00:00.000Z' },
      { id: 'user_03OTHER', email: 'bo@example.com', name: 'Bo', last_login_at: '2026-11-16T09:00:00.000Z' },
    ]);
  } finally {
    await client.close();
  }
}, PGLITE_START_MS);
