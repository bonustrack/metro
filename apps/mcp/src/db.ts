import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import * as schema from '@metro-labs/connectors/db/schema';

const IDLE_SECONDS = 20;
const LIFETIME_SECONDS = 30 * 60;

export function connectDb(url: string): Database {
  const sql = postgres(url, {
    max: 4,
    idle_timeout: IDLE_SECONDS,
    max_lifetime: LIFETIME_SECONDS,
    connection: { application_name: 'metro-mcp' },
    prepare: false,
    onnotice: (notice) => {
      log.debug({ notice: notice.message }, 'postgres notice');
    },
  });
  return drizzle(sql, { schema });
}
