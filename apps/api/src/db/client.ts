import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { log } from '@metro-labs/core/log';
import * as schema from './schema.js';

const IDLE_SECONDS = 20;
const LIFETIME_SECONDS = 30 * 60;

export type Db = PostgresJsDatabase<typeof schema>;

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

let sql: ReturnType<typeof postgres> | null = null;
let db: Db | null = null;

function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return undefined;
  return url;
}

export function getDb(): Db {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!db) {
    sql = postgres(url, {
      max: 4,
      idle_timeout: IDLE_SECONDS,
      max_lifetime: LIFETIME_SECONDS,
      connection: { application_name: 'metro-api' },
      prepare: false,
      onnotice: (notice) => {
        log.debug({ notice: notice.message }, 'postgres notice');
      },
    });
    db = drizzle(sql, { schema });
  }
  return db;
}

