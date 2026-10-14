import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { openConnectorSecret, sealConnectorSecret } from '@metro-labs/connectors/model';
import { orgConnectorStore } from '@metro-labs/connectors/db/connectors';
import * as schema from '../src/db/schema.js';
import { assignConnector, enrollLegacyAgent, MASTER, newEnrolledAgent, seedConnector, seedLegacyMigration } from './connector-agent-fixture.js';
import { TEST_OWNER } from './identity-helper.js';
import { PGLITE_START_MS } from './pglite-db.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const rows = async (client: PGlite, table: string): Promise<Record<string, unknown>[]> => (await client.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY 1`)).rows;

function through(dir: string, last: number): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(path, JSON.stringify(journal));
}

test('0009 drops name uniqueness without rewriting legacy IDs, secrets, assignments or source mappings, and the migrator can run again', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'metro-connector-instances-migration-'));
  const nine = mkdtempSync(join(tmpdir(), 'metro-connector-instances-nine-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const agent = newEnrolledAgent();
  try {
    through(folder, 8);
    through(nine, 9);
    await migrate(db, { migrationsFolder: folder });
    await enrollLegacyAgent(db, agent);
    const legacy = await seedConnector(db, { kind: 'header', targetUrl: 'https://vendor.example/mcp', name: 'Authorization', value: 'Bearer legacy-key-fixture' }, { policy: '{"write":"deny"}' });
    await assignConnector(db, agent);
    await seedConnector(db, { kind: 'header', targetUrl: 'https://vendor.example/keyed', name: 'Authorization', value: 'Bearer migrated-key-fixture' }, { id: 'conn0000003', name: 'Migrated Calendar' });
    await assignConnector(db, agent, 'conn0000003');
    await seedLegacyMigration(db, agent, 'conn0000003');
    const store = orgConnectorStore(() => db);
    const duplicate = { ...legacy, id: 'conn0000002' };
    duplicate.secret = sealConnectorSecret(MASTER, duplicate, { kind: 'header', targetUrl: 'https://vendor.example/mcp', name: 'Authorization', value: 'Bearer duplicate-key-fixture' });
    await expect(store.create(duplicate)).rejects.toThrow();
    const tables = ['agents', 'agent_keys', 'connectors', 'connector_agents', 'connector_migrations', 'connector_events'];
    const before = await Promise.all(tables.map((table) => rows(client, table)));
    const journal = await rows(client, 'drizzle.__drizzle_migrations');
    await migrate(db, { migrationsFolder: nine });
    expect(await Promise.all(tables.map((table) => rows(client, table)))).toEqual(before);
    const applied = await rows(client, 'drizzle.__drizzle_migrations');
    expect(applied.slice(0, journal.length)).toEqual(journal);
    expect(applied).toHaveLength(journal.length + 1);
    const indexes = await client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'connectors' ORDER BY indexname");
    expect(indexes.rows.map((row) => row.indexname)).toEqual(['connectors_owner_idx', 'connectors_pkey']);
    await store.create(duplicate);
    await store.edit(TEST_OWNER, duplicate.id, new Date().toISOString(), () => ({ change: { name: 'Migrated Calendar' } }));
    const after = await Promise.all(tables.map((table) => rows(client, table)));
    await migrate(db, { migrationsFolder: nine });
    expect(await rows(client, 'drizzle.__drizzle_migrations')).toEqual(applied);
    expect(await Promise.all(tables.map((table) => rows(client, table)))).toEqual(after);
    expect(await store.find(TEST_OWNER, legacy.id)).toEqual(legacy);
    expect(openConnectorSecret(MASTER, legacy)).toMatchObject({ value: 'Bearer legacy-key-fixture' });
    await expect(store.create(duplicate)).rejects.toThrow('connector identity');
  } finally {
    await client.close();
    rmSync(folder, { recursive: true, force: true });
    rmSync(nine, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
