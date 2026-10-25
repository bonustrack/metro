import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../src/db/client.ts';
import * as schema from '../src/db/schema.ts';

export const PGLITE_START_MS = 60_000;
export const PGLITE_STEP_MS = 20_000;

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const TABLES = ['model_calls', 'model_windows', 'model_routes', 'model_connections', 'model_hosts', 'mcp_calls', 'mcp_approvals', 'agent_nonces', 'agent_tokens', 'agent_keys', 'connector_agents', 'connectors', 'aws_connections', 'aws_external_ids', 'organizations', 'users', 'agents'];

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
  await db.execute(sql`INSERT INTO agents (id, owner, host, added_at, slug) VALUES (${id}, ${owner}, ${host}, '2026-10-09T00:00:00.000Z', ${id.toLowerCase()})`);
}

export async function addRemoteAgent(db: Database, id: string, owner: string, name = 'Remote'): Promise<void> {
  await db.insert(schema.agents).values({ id, owner, kind: 'remote', host: null, name, addedAt: '2026-10-23T00:00:00.000Z', slug: id.toLowerCase() });
}
