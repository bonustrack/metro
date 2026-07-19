import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

let sql: ReturnType<typeof postgres> | null = null;
let db: Db | null = null;

export function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return undefined;
  return url;
}

export function hasDatabase(): boolean {
  return databaseUrl() !== undefined;
}

export function getDb(): Db {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!db) {
    sql = postgres(url, { max: 4, prepare: false });
    db = drizzle(sql, { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (sql) await sql.end({ timeout: 5 });
  sql = null;
  db = null;
}
