import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../src/db/client.js';
import { awsConnections, awsExternalIds, organizations, users } from '../src/db/schema.js';
import { assignConnector, enrollDeliveryAgent, newDeliveryAgent, oauthSecret, seedConnector } from './connector-delivery-fixture.js';
import { answer, input, payload, prepared, startMigrationApi } from './connector-migration-fixture.js';
import { postgresFixture, TEST_DATABASE_URL } from './connector-postgres-fixture.js';
import { TEST_OWNER } from './identity-helper.js';
import { PGLITE_START_MS, testDb } from './pglite-db.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const TAG = '0010_drop_connector_events';
const DROP = readFileSync(join(DIR, 'pending', `${TAG}.sql`), 'utf8');
const AT = '2026-10-12T00:00:00.000Z';
const SAFETY_TABLES = ['agents', 'agent_keys', 'agent_nonces', 'agent_nonce_guard', 'connectors', 'connector_agents', 'connector_migrations'];
type Query = (statement: string) => Promise<Record<string, unknown>[]>;

async function seed(db: Database): Promise<void> {
  const agent = newDeliveryAgent();
  await enrollDeliveryAgent(db, agent);
  await seedConnector(db, oauthSecret(Date.now() + 3600_000));
  await assignConnector(db, agent);
  const api = await startMigrationApi(db);
  try {
    await prepared(api, agent, payload({ name: 'Retained migration' }));
    await answer(await api.call(agent, input('activate')));
  } finally { await api.close(); }
  await db.insert(users).values({ id: 'user_fixture', updatedAt: AT, name: 'Retained user' });
  await db.insert(organizations).values({ id: TEST_OWNER, slug: 'retained-org', createdAt: AT, updatedAt: AT });
  await db.insert(awsConnections).values({ id: 'aws00000001', owner: TEST_OWNER, accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/fixture', addedAt: AT });
  await db.insert(awsExternalIds).values({ owner: TEST_OWNER, externalId: 'retained-external-id', createdAt: AT });
}

async function tableNames(query: Query): Promise<string[]> {
  const rows = await query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename');
  return rows.map((row) => String(row.tablename));
}

async function retained(query: Query) {
  const names = (await tableNames(query)).filter((name) => name !== 'connector_events');
  const rows = await Promise.all(names.map(async (name) => ({ name, rows: await query(`SELECT row_to_json(t)::text AS row FROM "${name.replaceAll('"', '""')}" AS t ORDER BY row`) })));
  const columns = await query("SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> 'connector_events' ORDER BY table_name, ordinal_position");
  const constraints = await query("SELECT conname, contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conrelid IS DISTINCT FROM to_regclass('connector_events') ORDER BY conname");
  const indexes = await query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename <> 'connector_events' ORDER BY indexname");
  return { rows, columns, constraints, indexes };
}

async function verifyDrop(db: Database, query: Query, execute: (statement: string) => Promise<unknown>): Promise<void> {
  expect(await tableNames(query)).toContain('connector_events');
  await seed(db);
  expect(await query('SELECT * FROM connector_events')).toEqual([]);
  await execute(`INSERT INTO connector_events (id, owner, connector, agent, actor, action, detail, at) VALUES ('event000001', '${TEST_OWNER}', 'conn0000001', 'agent000001', 'user:fixture', 'connector.created', '{"name":"Calendar"}', '${AT}')`);
  expect(await query("SELECT conname FROM pg_constraint WHERE contype = 'f' AND (conrelid = 'connector_events'::regclass OR confrelid = 'connector_events'::regclass)")).toEqual([]);
  const tables = await tableNames(query);
  const before = await retained(query);
  for (const name of SAFETY_TABLES) expect(before.rows.find((table) => table.name === name)?.rows.length).toBeGreaterThan(0);
  await execute(DROP);
  expect(await tableNames(query)).toEqual(tables.filter((name) => name !== 'connector_events'));
  const after = await retained(query);
  expect(after).toEqual(before);
}

test('the Activity drop stays outside the first release journal and contains no cascading cleanup', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  expect(journal.entries.some((entry) => entry.tag === TAG)).toBe(false);
  expect(existsSync(join(DIR, `${TAG}.sql`))).toBe(false);
  expect(DROP.trim()).toBe('DROP TABLE connector_events;');
});

test('the pending Activity drop preserves every other table, row and constraint on a fresh database and does not change migration receipts', async () => {
  const held = await testDb({ retainActivity: true });
  const query: Query = async (statement) => (await held.client.query<Record<string, unknown>>(statement)).rows;
  try {
    const receipts = await query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
    await verifyDrop(held.db, query, (statement) => held.client.exec(statement));
    await migrate(drizzle(held.client), { migrationsFolder: DIR });
    expect(await query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).toEqual(receipts);
    expect(await tableNames(query)).not.toContain('connector_events');
  } finally { await held.close(); }
}, PGLITE_START_MS);

test.skipIf(TEST_DATABASE_URL === undefined)('the pending Activity drop preserves safety data on disposable real PostgreSQL', async () => {
  if (TEST_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL is required');
  const held = await postgresFixture(TEST_DATABASE_URL, { retainActivity: true });
  try {
    await verifyDrop(held.db1, (statement) => held.one.unsafe(statement), (statement) => held.one.unsafe(statement));
  } finally { await held.close(); }
}, 30_000);
