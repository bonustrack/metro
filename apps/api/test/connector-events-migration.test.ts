import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { orgConnectorStore } from '@metro-labs/connectors/db/connectors';
import { readToolListings } from '@metro-labs/connectors/db/connector-tools';
import { mcpCallStore } from '@metro-labs/connectors/db/mcp-calls';
import * as schema from '../src/db/schema.ts';
import { TEST_OWNER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS } from './pglite-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const TAG = '0026_connector_events';
const AT = '2026-11-09T00:00:00.000Z';
const NOW = Date.parse('2026-11-10T09:00:00.000Z');
const TOOLS = JSON.stringify([{ name: 'search', title: 'Search', description: '', readOnly: true }]);

const OLD_CONNECTOR = "INSERT INTO connectors (id, owner, name, url, auth, created_by, created_at, updated_at) VALUES ($1, $2, $3, 'https://vendor.example', 'header', 'user_01TEST', $4, $4)";
const OLD_ASSIGNMENT = "INSERT INTO connector_agents (connector, agent, policy, created_by, created_at) VALUES ($1, $2, $3, 'user_01TEST', $4)";
const OLD_LISTING = 'INSERT INTO connector_tools (connector, tools, icons, listed_at, failure_code, failure, failed_at) VALUES ($1, $2, $3, $4, null, null, null)';
const OLD_CALL = "INSERT INTO mcp_calls (id, owner, agent, agent_name, connector, connector_key, connector_name, tool, outcome, ms, at) VALUES ($1, $2, $3, 'Emma', $4, 'tracker', 'Tracker', 'search', 'ok', 12, $5)";

function through(dir: string, last: number): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(path, JSON.stringify(journal));
}

async function oldWrites(client: PGlite, connector: string, agent: string, call: string, at: number): Promise<void> {
  await client.query(OLD_CONNECTOR, [connector, TEST_OWNER, `Tracker ${connector}`, AT]);
  await client.query(OLD_ASSIGNMENT, [connector, agent, '{"write":"deny"}', AT]);
  await client.query(OLD_LISTING, [connector, TOOLS, '[]', at]);
  await client.query(OLD_CALL, [call, TEST_OWNER, agent, connector, at]);
}

const one = async <T>(client: PGlite, statement: string): Promise<T[]> => (await client.query<T>(statement)).rows;

test('0026 is journaled after 0025', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const before = journal.entries.find((entry) => entry.idx === 25);
  const added = journal.entries.find((entry) => entry.idx === 26);
  expect(added).toMatchObject({ tag: TAG });
  expect(added?.when ?? 0).toBeGreaterThan(before?.when ?? Number.MAX_SAFE_INTEGER);
});

test('after 0026 old rows read with the defaults, and a writer that names only the old columns still works', async () => {
  const before = mkdtempSync(join(tmpdir(), 'metro-connector-events-before-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const store = orgConnectorStore(() => db);
  try {
    through(before, 25);
    await migrate(db, { migrationsFolder: before });
    await addAgent(db, 'agent000001', TEST_OWNER);
    await oldWrites(client, 'conn0000001', 'agent000001', 'call0000001', NOW);
    const receipts = await one(client, 'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');

    await migrate(db, { migrationsFolder: DIR });
    await oldWrites(client, 'conn0000002', 'agent000001', 'call0000002', NOW + 1);

    expect(await one(client, 'SELECT connector, policy, events, senders FROM connector_agents ORDER BY connector')).toEqual([
      { connector: 'conn0000001', policy: '{"write":"deny"}', events: '[]', senders: '["*"]' },
      { connector: 'conn0000002', policy: '{"write":"deny"}', events: '[]', senders: '["*"]' },
    ]);
    expect(await one(client, 'SELECT connector, tools, events FROM connector_tools ORDER BY connector')).toEqual([
      { connector: 'conn0000001', tools: TOOLS, events: null },
      { connector: 'conn0000002', tools: TOOLS, events: null },
    ]);
    expect(await one(client, 'SELECT id, outcome, kind FROM mcp_calls ORDER BY id')).toEqual([
      { id: 'call0000001', outcome: 'ok', kind: 'call' },
      { id: 'call0000002', outcome: 'ok', kind: 'call' },
    ]);

    const listed = await store.list(TEST_OWNER);
    expect(listed.assignments.map((row) => [row.connector, row.events, row.senders])).toEqual(expect.arrayContaining([['conn0000001', '[]', '["*"]'], ['conn0000002', '[]', '["*"]']]));
    expect(await store.offered(['conn0000001', 'conn0000002'])).toEqual(new Map([['conn0000001', []], ['conn0000002', []]]));
    expect(await store.subscriptions(TEST_OWNER)).toEqual([]);
    expect((await readToolListings(db, ['conn0000001'])).get('conn0000001')).toMatchObject({ events: [], listedAt: NOW, tools: [{ name: 'search' }] });
    expect((await mcpCallStore(() => db).recent(TEST_OWNER, { limit: 10 })).map((call) => [call.id, call.kind])).toEqual([['call0000002', 'call'], ['call0000001', 'call']]);

    await expect(client.query("UPDATE mcp_calls SET kind = 'other' WHERE id = 'call0000001'")).rejects.toThrow('mcp_calls_kind_check');
    await client.query("UPDATE mcp_calls SET kind = 'event', outcome = 'delivered' WHERE id = 'call0000001'");
    expect(await one(client, "SELECT to_regclass('connector_subscriptions')::text AS subscriptions, to_regclass('connector_events')::text AS events")).toEqual([{ subscriptions: 'connector_subscriptions', events: 'connector_events' }]);

    const applied = await one(client, 'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
    expect(applied.slice(0, receipts.length)).toEqual(receipts);
    expect(applied).toHaveLength(receipts.length + 1);
    await migrate(db, { migrationsFolder: DIR });
    expect(await one(client, 'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).toEqual(applied);
    expect(await one(client, 'SELECT count(*)::int AS n FROM connector_agents')).toEqual([{ n: 2 }]);
  } finally {
    await client.close();
    rmSync(before, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
