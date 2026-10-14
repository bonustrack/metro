import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { awsConnections, awsExternalIds, organizations, users } from '../src/db/schema.js';
import { assignConnector, enrollDeliveryAgent, newDeliveryAgent, oauthSecret, seedConnector, seedLegacyMigration, startDeliveryApi } from './connector-delivery-fixture.js';
import { TEST_OWNER } from './identity-helper.js';
import { PGLITE_START_MS } from './pglite-db.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const AT = '2026-10-12T00:00:00.000Z';
const DROPPED = ['connector_events', 'connector_migrations'];
const KEPT = ['agents', 'agent_keys', 'agent_nonces', 'agent_nonce_guard', 'connectors', 'connector_agents'];
type Query = (statement: string) => Promise<Record<string, unknown>[]>;

function throughNine(dir: string): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 9);
  writeFileSync(path, JSON.stringify(journal));
}

async function seed(db: Database, execute: (statement: string) => Promise<unknown>): Promise<void> {
  const agent = newDeliveryAgent();
  await enrollDeliveryAgent(db, agent);
  await seedConnector(db, oauthSecret(Date.now() + 3600_000));
  await assignConnector(db, agent);
  await seedConnector(db, { kind: 'header', targetUrl: 'https://vendor.example/keyed', name: 'Authorization', value: 'Bearer retained-key' }, { id: 'conn0000002', name: 'Migrated connector' });
  await assignConnector(db, agent, 'conn0000002');
  await seedLegacyMigration(db, agent, 'conn0000002');
  const delivery = await startDeliveryApi(db);
  try {
    expect((await delivery.call(agent)).status).toBe(200);
  } finally { await delivery.close(); }
  await db.insert(users).values({ id: 'user_fixture', updatedAt: AT, name: 'Retained user' });
  await db.insert(organizations).values({ id: TEST_OWNER, slug: 'retained-org', createdAt: AT, updatedAt: AT });
  await db.insert(awsConnections).values({ id: 'aws00000001', owner: TEST_OWNER, accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/fixture', addedAt: AT });
  await db.insert(awsExternalIds).values({ owner: TEST_OWNER, externalId: 'retained-external-id', createdAt: AT });
  await execute(`INSERT INTO connector_events (id, owner, connector, agent, actor, action, detail, at) VALUES ('event000001', '${TEST_OWNER}', 'conn0000001', 'agent000001', 'user:fixture', 'connector.created', '{"name":"Calendar"}', '${AT}')`);
}

const tableNames = async (query: Query): Promise<string[]> =>
  (await query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename')).map((row) => String(row.tablename));

async function retained(query: Query) {
  const names = (await tableNames(query)).filter((name) => !DROPPED.includes(name));
  const rows = await Promise.all(names.map(async (name) => ({
    name,
    rows: await query(`SELECT (to_jsonb(t) - 'migration_operation')::text AS row FROM "${name}" AS t ORDER BY row`),
  })));
  const skip = `table_name NOT IN ('connector_events', 'connector_migrations') AND NOT (table_name = 'connector_agents' AND column_name = 'migration_operation')`;
  const columns = await query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND ${skip} ORDER BY table_name, ordinal_position`);
  const constraints = await query("SELECT conname, contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conrelid NOT IN (SELECT oid FROM pg_class WHERE relname IN ('connector_events', 'connector_migrations')) ORDER BY conname");
  const indexes = await query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename NOT IN ('connector_events', 'connector_migrations') ORDER BY indexname");
  return { rows, columns, constraints, indexes };
}

test('0010 is journaled and drops only Activity, the migration table and the migration column', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
  expect(journal.entries.at(-1)).toMatchObject({ idx: 10, tag: '0010_drop_connector_legacy' });
  const sql = readFileSync(join(DIR, '0010_drop_connector_legacy.sql'), 'utf8');
  expect(sql).not.toMatch(/cascade/i);
  expect(sql.match(/^(DROP|ALTER) .*$/gm)).toEqual(['DROP TABLE "connector_events";', 'DROP TABLE "connector_migrations";', 'ALTER TABLE "connector_agents" DROP COLUMN "migration_operation";']);
});

test('0010 removes the legacy objects and keeps every other table, row, column, constraint and index', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'metro-connector-legacy-drop-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const query: Query = async (statement) => (await client.query<Record<string, unknown>>(statement)).rows;
  try {
    throughNine(folder);
    await migrate(db, { migrationsFolder: folder });
    await seed(db, (statement) => client.exec(statement));
    for (const name of [...DROPPED, ...KEPT]) expect((await query(`SELECT * FROM "${name}"`)).length).toBeGreaterThan(0);
    const tables = await tableNames(query);
    const before = await retained(query);
    const receipts = await query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
    await migrate(db, { migrationsFolder: DIR });
    expect(await tableNames(query)).toEqual(tables.filter((name) => !DROPPED.includes(name)));
    expect(await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'connector_agents' AND column_name = 'migration_operation'")).toEqual([]);
    expect(await retained(query)).toEqual(before);
    const applied = await query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
    expect(applied.slice(0, receipts.length)).toEqual(receipts);
    expect(applied).toHaveLength(receipts.length + 1);
    await migrate(db, { migrationsFolder: DIR });
    expect(await query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).toEqual(applied);
  } finally {
    await client.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
