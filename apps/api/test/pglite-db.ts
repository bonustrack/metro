import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../src/db/client.ts';
import * as schema from '../src/db/schema.ts';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const TABLES = ['box_keys', 'connector_events', 'connector_agents', 'connectors', 'connector_keys', 'aws_connections', 'aws_external_ids', 'organizations', 'users', 'agents'];

export interface TestDb {
  db: Database;
  client: PGlite;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function testDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return {
    db,
    client,
    reset: async () => {
      await client.exec(`TRUNCATE ${TABLES.map((table) => `"${table}"`).join(', ')} CASCADE`);
    },
    close: () => client.close(),
  };
}

export async function addAgent(db: Database, id: string, owner: string, host = `${id.toLowerCase()}.tail0000.ts.net`): Promise<void> {
  await db.insert(schema.agents).values({ id, owner, host, addedAt: '2026-10-09T00:00:00.000Z', slug: id.toLowerCase() });
}
