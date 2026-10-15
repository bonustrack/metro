import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { leaveOrganization } from '@metro-labs/connectors/db/agent-keys';
import { orgModelStore } from '@metro-labs/connectors/db/models';
import { routeText } from '@metro-labs/connectors/model-route';
import * as schema from '../src/db/schema.ts';
import { agents, connectors, modelConnections, modelRoutes } from '../src/db/schema.ts';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const AT = '2026-10-15T00:00:00.000Z';

let held: TestDb;

const connection = (id: string, owner = TEST_OWNER, patch: Partial<typeof modelConnections.$inferInsert> = {}): typeof modelConnections.$inferInsert => ({
  id, owner, provider: 'openrouter', label: 'OpenRouter', model: '', region: '', zdr: false, secret: null, detail: null, revision: 1, importAgent: null, importId: null, createdBy: 'user:test', createdAt: AT, updatedAt: AT, ...patch,
});

const routeRow = (id: string, agent: string | null, owner = TEST_OWNER): typeof modelRoutes.$inferInsert => ({
  id, owner, agent, route: routeText({ primary: { connection: 'conn0000001', model: 'm' }, fallbacks: [] }), updatedBy: 'user:test', updatedAt: AT,
});

const refused = async (work: () => Promise<unknown>): Promise<void> => {
  let failed = false;
  try {
    await work();
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
};

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  await addAgent(held.db, 'agent000001', TEST_OWNER);
  await addAgent(held.db, 'agent000002', TEST_OWNER);
}, PGLITE_STEP_MS);

afterAll(async () => {
  await held.close();
});

test('0014 is journaled after 0013 and only adds the three model tables to existing data', async () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
  const entry = journal.entries.find((e) => e.idx === 14);
  expect(entry).toMatchObject({ tag: '0014_org_models' });
  expect(entry?.when ?? 0).toBeGreaterThan(journal.entries.find((e) => e.idx === 13)?.when ?? Infinity);
  const folder = mkdtempSync(join(tmpdir(), 'metro-org-models-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    cpSync(DIR, folder, { recursive: true });
    const path = join(folder, 'meta', '_journal.json');
    writeFileSync(path, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 13) }));
    await migrate(db, { migrationsFolder: folder });
    await db.insert(agents).values({ id: 'agent000001', owner: TEST_OWNER, host: 'a.ts.net', addedAt: AT });
    await db.insert(connectors).values({ id: 'conn0000001', owner: TEST_OWNER, name: 'Linear', url: 'https://mcp.linear.app', auth: 'none', createdBy: 'user', createdAt: AT, updatedAt: AT });
    await migrate(db, { migrationsFolder: DIR });
    const tables = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'model_%' ORDER BY tablename")).rows.map((row) => row.tablename);
    expect(tables).toEqual(['model_connections', 'model_hosts', 'model_routes']);
    expect(await db.$count(connectors)).toBe(1);
    expect(await db.$count(agents)).toBe(1);
  } finally {
    await client.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, PGLITE_START_MS);

describe('the model tables', () => {
  test('one default per organization, one override per agent, and an override goes with its agent', async () => {
    await held.db.insert(modelRoutes).values(routeRow('route000001', null));
    await held.db.insert(modelRoutes).values(routeRow('route000002', null, TEST_STRANGER));
    await refused(() => held.db.insert(modelRoutes).values(routeRow('route000003', null)));
    await held.db.insert(modelRoutes).values(routeRow('route000004', 'agent000001'));
    await refused(() => held.db.insert(modelRoutes).values(routeRow('route000005', 'agent000001')));
    await refused(() => held.db.insert(modelRoutes).values(routeRow('route000006', 'nosuchagent')));
    await held.db.delete(agents).where(eq(agents.id, 'agent000001'));
    expect((await held.db.select().from(modelRoutes)).map((row) => row.id).sort()).toEqual(['route000001', 'route000002']);
  });

  test('an import marker is unique per agent and old id, providers and host ids are checked', async () => {
    await held.db.insert(modelConnections).values(connection('conn0000001', TEST_OWNER, { importAgent: 'agent000001', importId: 'oldid000001' }));
    await refused(() => held.db.insert(modelConnections).values(connection('conn0000002', TEST_OWNER, { importAgent: 'agent000001', importId: 'oldid000001' })));
    await held.db.insert(modelConnections).values(connection('conn0000003', TEST_OWNER, { importAgent: 'agent000002', importId: 'oldid000001' }));
    await refused(() => held.db.insert(modelConnections).values(connection('conn0000004', TEST_OWNER, { provider: 'gemini' })));
    await refused(() => held.db.insert(modelConnections).values(connection('conn0000005', TEST_OWNER, { importAgent: 'agent000001' })));
    await refused(() => held.db.execute(sql`INSERT INTO model_hosts (owner, chatgpt_host_id) VALUES ('org_x', 'not-a-urn')`));
  });

  test('leaving an organization drops the agent’s override and its import markers, not the connections', async () => {
    await held.db.insert(modelConnections).values(connection('conn0000001', TEST_OWNER, { importAgent: 'agent000001', importId: 'oldid000001' }));
    await held.db.insert(modelRoutes).values(routeRow('route000001', 'agent000001'));
    await held.db.insert(modelRoutes).values(routeRow('route000002', null));
    await held.db.transaction((tx) => leaveOrganization(tx, 'agent000001'));
    expect((await held.db.select().from(modelRoutes)).map((row) => row.id)).toEqual(['route000002']);
    expect((await held.db.select().from(modelConnections))[0]).toMatchObject({ id: 'conn0000001', importAgent: null, importId: null });
  });

  test('an edit that changes the credential moves the revision, others do not', async () => {
    const store = orgModelStore(() => held.db);
    await held.db.insert(modelConnections).values(connection('conn0000001'));
    expect((await store.edit(TEST_OWNER, 'conn0000001', AT, () => ({ change: { label: 'Renamed' } }))).revision).toBe(1);
    expect((await store.edit(TEST_OWNER, 'conn0000001', AT, () => ({ change: { secret: 'v1.x' }, credential: true }))).revision).toBe(2);
    await refused(() => store.edit(TEST_STRANGER, 'conn0000001', AT, () => ({ change: { label: 'Theirs' } })));
    expect(await store.hostId(TEST_OWNER)).toBe(await store.hostId(TEST_OWNER));
    expect(await store.hostId(TEST_OWNER)).not.toBe(await store.hostId(TEST_STRANGER));
  });
});
