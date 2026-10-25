import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import * as schema from '@metro-labs/connectors/db/schema';

export function connectDb(url: string): Database {
  const sql = postgres(url, {
    max: 8,
    prepare: false,
    onnotice: (notice) => {
      log.debug({ notice: notice.message }, 'postgres notice');
    },
  });
  return drizzle(sql, { schema });
}
