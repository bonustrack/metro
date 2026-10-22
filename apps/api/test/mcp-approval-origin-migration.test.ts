import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createAgentToken } from '@metro-labs/connectors/db/agent-tokens';
import { approvalStore } from '@metro-labs/connectors/db/mcp-approvals';
import * as schema from '../src/db/schema.ts';
import { addAgent, PGLITE_START_MS } from './pglite-db.ts';
import { TEST_OWNER } from './identity-helper.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const TAG = '0020_mcp_approval_origin';
const AGENT = 'agent000001';
const NOW = Date.parse('2026-10-23T09:00:00.000Z');
const DIGEST = 'd'.repeat(43);

function through(dir: string, last: number): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(path, JSON.stringify(journal));
}

const OLD_INSERT = 'INSERT INTO mcp_approvals (id, owner, agent, connector, tool, args_digest, preview, state, requested_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)';

test('0020 is journaled after 0019', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const nineteen = journal.entries.find((entry) => entry.idx === 19);
  const twenty = journal.entries.find((entry) => entry.idx === 20);
  expect(twenty).toMatchObject({ tag: TAG });
  expect(twenty?.when ?? 0).toBeGreaterThan(nineteen?.when ?? Number.MAX_SAFE_INTEGER);
});

test('after 0020 old rows keep no origin, an old machine still inserts, and each caller has its own pending request', async () => {
  const nineteen = mkdtempSync(join(tmpdir(), 'metro-origin-nineteen-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const store = approvalStore(() => db);
  const callOf = (token?: string) => ({ connector: 'conn0000001', tool: 'update_page', digest: DIGEST, preview: '{}', ...(token === undefined ? {} : { token }) });
  try {
    through(nineteen, 19);
    await migrate(db, { migrationsFolder: nineteen });
    await addAgent(db, AGENT, TEST_OWNER);
    await client.query(OLD_INSERT, ['abcde', TEST_OWNER, AGENT, 'conn0000001', 'update_page', DIGEST, '{}', 'pending', NOW]);

    await migrate(db, { migrationsFolder: DIR });
    const columns = await client.query<{ column_name: string; is_nullable: string }>("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'mcp_approvals' AND column_name IN ('origin', 'token') ORDER BY column_name");
    expect(columns.rows).toEqual([{ column_name: 'origin', is_nullable: 'YES' }, { column_name: 'token', is_nullable: 'YES' }]);
    const old = await client.query<{ origin: string | null; token: string | null }>("SELECT origin, token FROM mcp_approvals WHERE id = 'abcde'");
    expect(old.rows).toEqual([{ origin: null, token: null }]);

    expect(await store.request({ agent: AGENT, owner: TEST_OWNER }, callOf(), NOW + 1)).toBe('abcde');
    await expect(client.query(OLD_INSERT, ['bcdef', TEST_OWNER, AGENT, 'conn0000001', 'update_page', DIGEST, '{}', 'pending', NOW + 2])).rejects.toThrow('mcp_approvals_pending_idx');
    await expect(client.query("INSERT INTO mcp_approvals (id, owner, agent, connector, tool, args_digest, preview, state, requested_at, origin) VALUES ('cdefg', $1, $2, 'conn0000001', 'update_page', $3, '{}', 'pending', $4, 'box')", [TEST_OWNER, AGENT, DIGEST, NOW + 3])).rejects.toThrow('mcp_approvals_pending_idx');

    const key = await createAgentToken(db, { owner: TEST_OWNER, agent: AGENT, label: 'Laptop', createdBy: 'user_01TEST', now: NOW });
    const keyed = await store.request({ agent: AGENT, owner: TEST_OWNER }, callOf(key.row.id), NOW + 4);
    expect(keyed).not.toBe('abcde');
    await client.query(OLD_INSERT, ['defgh', TEST_OWNER, AGENT, 'conn0000001', 'delete_page', DIGEST, '{}', 'pending', NOW + 5]);
    const rows = await client.query<{ id: string; origin: string | null; token: string | null }>('SELECT id, origin, token FROM mcp_approvals ORDER BY requested_at');
    expect(rows.rows).toEqual([{ id: 'abcde', origin: null, token: null }, { id: keyed, origin: 'key', token: key.row.id }, { id: 'defgh', origin: null, token: null }]);
  } finally {
    await client.close();
    rmSync(nineteen, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
