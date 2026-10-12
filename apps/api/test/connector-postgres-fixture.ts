import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from '../src/db/schema.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

export async function postgresFixture(url: string) {
  const name = `connector_test_${randomBytes(8).toString('hex')}`;
  const admin = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  await admin`create schema ${admin(name)}`;
  const one = postgres(url, { max: 1, prepare: false, connection: { search_path: name, application_name: `${name}_one` }, onnotice: () => {} });
  const two = postgres(url, { max: 1, prepare: false, connection: { search_path: name, application_name: `${name}_two` }, onnotice: () => {} });
  const db1 = drizzle(one, { schema });
  const db2 = drizzle(two, { schema });
  try {
    for (const migration of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
      for (const statement of migration.sql) await one.unsafe(statement.replaceAll('"public".', `"${name}".`));
    }
  } catch (err) {
    await one.end();
    await two.end();
    await admin`drop schema ${admin(name)} cascade`;
    await admin.end();
    throw err;
  }
  return {
    db1, db2, one, two,
    reset: () => one`truncate connector_migrations, agent_nonces, agent_keys, connector_events, connector_agents, connectors, agents cascade`,
    waiting: async (pool: 'one' | 'two') => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await admin<{ wait_event_type: string | null }[]>`select wait_event_type from pg_stat_activity where application_name = ${`${name}_${pool}`} and datname = current_database()`;
        if (rows.some((row) => row.wait_event_type === 'Lock')) return;
        await Bun.sleep(20);
      }
      throw new Error(`Pool ${pool} never waited on a Postgres row lock`);
    },
    close: async () => {
      await one.end();
      await two.end();
      await admin`drop schema ${admin(name)} cascade`;
      await admin.end();
    },
  };
}
