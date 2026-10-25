import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { errMsg, log, logFatalSync } from '@metro-labs/core/log';
import { causesOf } from '@metro-labs/http/api-http';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim() ?? '';
  if (url === '') throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  () => {
    log.info({}, 'db: migrations applied');
  },
  (err: unknown) => {
    logFatalSync({ err: errMsg(err), ...causesOf(err) }, 'db: migrations failed');
    process.exit(1);
  },
);
