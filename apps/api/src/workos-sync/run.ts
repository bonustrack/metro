import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { errMsg } from '@metro-labs/core/log';
import { readWorkosConfig } from '../auth/workos.js';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import { applyPlan } from './apply.js';
import { planSync, type SyncPlan } from './plan.js';
import { reportLines } from './report.js';
import { readWorkos, type Snapshot } from './snapshot.js';

const USAGE = 'usage: bun apps/api/scripts/workos-sync.ts [--apply]';

export function syncWorkos(db: Database, snapshot: Snapshot, options: { apply: boolean; now: number }): Promise<SyncPlan> {
  if (!options.apply) return planSync(db, snapshot);
  return db.transaction(async (tx) => {
    const plan = await planSync(tx, snapshot);
    await applyPlan(tx, plan, options.now);
    return plan;
  });
}

export async function runWorkosSync(argv: string[], env: NodeJS.ProcessEnv, write: (text: string) => void): Promise<number> {
  if (argv.some((arg) => arg !== '--apply')) {
    write(`${USAGE}\n`);
    return 2;
  }
  const cfg = readWorkosConfig(env);
  const url = env.DATABASE_URL?.trim() ?? '';
  if (cfg === null || url === '') {
    write('WORKOS_API_KEY, WORKOS_CLIENT_ID and DATABASE_URL must be set\n');
    return 1;
  }
  const apply = argv.includes('--apply');
  const sql = postgres(url, { max: 1, prepare: false, connection: { application_name: 'metro-workos-sync' }, onnotice: () => undefined });
  try {
    const plan = await syncWorkos(drizzle(sql, { schema }), await readWorkos(cfg), { apply, now: Date.now() });
    write(`${reportLines(plan, apply).join('\n')}\n`);
    return 0;
  } catch (err) {
    write(`workos-sync failed, nothing was written: ${errMsg(err)}\n`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
