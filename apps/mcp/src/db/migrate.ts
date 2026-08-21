import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { log } from '../daemon/log.js';
import { closeDb, databaseUrl, getDb } from './client.js';

export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

export async function migrateToLatest(): Promise<void> {
  if (databaseUrl() === undefined)
    throw new Error('DATABASE_URL is not set — cannot migrate');
  await migrate(getDb(), { migrationsFolder: MIGRATIONS_DIR });
}

export async function runMigrations(): Promise<void> {
  log.info({ dir: MIGRATIONS_DIR }, 'migrate: applying pending migrations');
  try {
    await migrateToLatest();
    log.info('migrate: schema is up to date');
  } finally {
    await closeDb();
  }
}
