import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../src/db/schema.ts';
import { PGLITE_START_MS } from './pglite-db.ts';
import { TEST_OWNER } from './identity-helper.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const TAG = '0026_connector_mail';
const AT = '2026-11-09T09:00:00.000Z';
const MS = Date.parse(AT);

function through(dir: string, last: number): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(path, JSON.stringify(journal));
}

const OLD_CALL = 'INSERT INTO mcp_calls (id, owner, agent, agent_name, connector, connector_key, connector_name, tool, outcome, ms, at) VALUES ($1, $2, $3, null, $4, $5, null, $6, $7, $8, $9)';
const OLD_ASSIGNMENT = 'INSERT INTO connector_agents (connector, agent, policy, created_by, created_at) VALUES ($1, $2, null, $3, $4)';

test('0026 is journaled after 0025', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const before = journal.entries.find((entry) => entry.idx === 25);
  const added = journal.entries.find((entry) => entry.idx === 26);
  expect(added).toMatchObject({ tag: TAG });
  expect(added?.when ?? 0).toBeGreaterThan(before?.when ?? Number.MAX_SAFE_INTEGER);
});

test('after 0026 old assignments let anyone write with Receive messages on, old calls are calls, and an old machine still writes both', async () => {
  const old = mkdtempSync(join(tmpdir(), 'metro-mail-migration-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    through(old, 25);
    await migrate(db, { migrationsFolder: old });
    await client.query("INSERT INTO agents (id, owner, host, added_at, slug) VALUES ('agent000001', $1, 'one.tail0000.ts.net', $2, 'one')", [TEST_OWNER, AT]);
    await client.query("INSERT INTO connectors (id, owner, name, url, auth, created_by, created_at, updated_at) VALUES ('conn0000001', $1, 'Gmail', 'https://mail.example.com', 'none', 'user_01TEST', $2, $2)", [TEST_OWNER, AT]);
    await client.query(OLD_ASSIGNMENT, ['conn0000001', 'agent000001', 'user_01TEST', AT]);
    await client.query(OLD_CALL, ['callold0001', TEST_OWNER, 'agent000001', 'conn0000001', 'gmail', 'reply', 'ok', 10, MS]);
    await client.query("INSERT INTO connector_tools (connector, tools, listed_at) VALUES ('conn0000001', '[]', $1)", [MS]);

    await migrate(db, { migrationsFolder: DIR });
    expect((await client.query('SELECT senders, receive FROM connector_agents')).rows).toEqual([{ senders: '["*"]', receive: true }]);
    expect((await client.query("SELECT kind FROM mcp_calls WHERE id = 'callold0001'")).rows).toEqual([{ kind: 'call' }]);
    expect((await client.query('SELECT events FROM connector_tools')).rows).toEqual([{ events: null }]);
    await client.query(OLD_CALL, ['callold0002', TEST_OWNER, 'agent000001', 'conn0000001', 'gmail', 'read', 'ok', 5, MS + 1]);
    expect((await client.query("SELECT kind FROM mcp_calls WHERE id = 'callold0002'")).rows).toEqual([{ kind: 'call' }]);
    await expect(client.query("UPDATE mcp_calls SET kind = 'other' WHERE id = 'callold0002'")).rejects.toThrow('mcp_calls_kind_check');

    const inbox = "INSERT INTO connector_inbox (id, owner, connector, agent, event_id, state, mail, received_at) VALUES ($1, $2, 'conn0000001', 'agent000001', $3, $4, $5, $6)";
    await client.query(inbox, ['inbox000001', TEST_OWNER, 'e1', 'waiting', 'v1.sealed', MS]);
    await expect(client.query(inbox, ['inbox000002', TEST_OWNER, 'e1', 'dropped', null, MS])).rejects.toThrow('connector_inbox_event_idx');
    await expect(client.query(inbox, ['inbox000003', TEST_OWNER, 'e2', 'waiting', null, MS])).rejects.toThrow('connector_inbox_mail_check');
    await expect(client.query(inbox, ['inbox000004', TEST_OWNER, 'e3', 'delivered', 'v1.sealed', MS])).rejects.toThrow('connector_inbox_mail_check');
    await client.query("DELETE FROM connectors WHERE id = 'conn0000001'");
    expect((await client.query('SELECT id FROM connector_inbox')).rows).toEqual([]);
  } finally {
    await client.close();
    rmSync(old, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
