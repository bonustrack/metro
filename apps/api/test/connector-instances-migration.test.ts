import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { openConnectorSecret, sealConnectorSecret } from '../src/connectors/model.js';
import { orgConnectorStore } from '../src/db/connectors.js';
import * as schema from '../src/db/schema.js';
import { assignConnector, enrollDeliveryAgent, MASTER, newDeliveryAgent, seedConnector } from './connector-delivery-fixture.js';
import { answer, input, payload, prepared, startMigrationApi } from './connector-migration-fixture.js';
import { TEST_OWNER } from './identity-helper.js';
import { PGLITE_START_MS } from './pglite-db.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const rows = async (client: PGlite, table: string): Promise<Record<string, unknown>[]> => (await client.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY 1`)).rows;

function throughEight(dir: string): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 8);
  writeFileSync(path, JSON.stringify(journal));
}

test('0009 drops name uniqueness without rewriting legacy IDs, secrets, assignments or source mappings, and the migrator can run again', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'metro-connector-instances-migration-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const agent = newDeliveryAgent();
  try {
    throughEight(folder);
    await migrate(db, { migrationsFolder: folder });
    await enrollDeliveryAgent(db, agent);
    const legacy = await seedConnector(db, { kind: 'header', targetUrl: 'https://vendor.example/mcp', name: 'Authorization', value: 'Bearer legacy-key-fixture' }, { policy: '{"write":"deny"}' });
    await assignConnector(db, agent);
    const api = await startMigrationApi(db);
    try {
      await prepared(api, agent, payload({ name: 'Migrated Calendar' }));
      await answer(await api.call(agent, input('activate')));
    } finally { await api.close(); }
    const store = orgConnectorStore(() => db);
    const duplicate = { ...legacy, id: 'conn0000002' };
    duplicate.secret = sealConnectorSecret(MASTER, duplicate, { kind: 'header', targetUrl: 'https://vendor.example/mcp', name: 'Authorization', value: 'Bearer duplicate-key-fixture' });
    await expect(store.create(duplicate)).rejects.toThrow();
    const tables = ['agents', 'agent_keys', 'connectors', 'connector_agents', 'connector_migrations', 'connector_events'];
    const before = await Promise.all(tables.map((table) => rows(client, table)));
    const journal = await rows(client, 'drizzle.__drizzle_migrations');
    await migrate(db, { migrationsFolder: DIR });
    expect(await Promise.all(tables.map((table) => rows(client, table)))).toEqual(before);
    const applied = await rows(client, 'drizzle.__drizzle_migrations');
    expect(applied.slice(0, journal.length)).toEqual(journal);
    expect(applied).toHaveLength(journal.length + 1);
    const indexes = await client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'connectors' ORDER BY indexname");
    expect(indexes.rows.map((row) => row.indexname)).toEqual(['connectors_owner_idx', 'connectors_pkey']);
    await store.create(duplicate);
    await store.edit(TEST_OWNER, duplicate.id, new Date().toISOString(), () => ({ change: { name: 'Migrated Calendar' } }));
    const after = await Promise.all(tables.map((table) => rows(client, table)));
    await migrate(db, { migrationsFolder: DIR });
    expect(await rows(client, 'drizzle.__drizzle_migrations')).toEqual(applied);
    expect(await Promise.all(tables.map((table) => rows(client, table)))).toEqual(after);
    expect(await store.find(TEST_OWNER, legacy.id)).toEqual(legacy);
    expect(openConnectorSecret(MASTER, legacy)).toMatchObject({ value: 'Bearer legacy-key-fixture' });
    await expect(store.create(duplicate)).rejects.toThrow('connector identity');
  } finally {
    await client.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
