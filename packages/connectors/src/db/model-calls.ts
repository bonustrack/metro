import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { Database } from './database.js';
import { agents, modelCalls, modelWindows } from './schema.js';

type ModelCallRow = typeof modelCalls.$inferSelect;

export type NewModelCall = Omit<ModelCallRow, 'agentName'>;

export type ModelWindowRow = typeof modelWindows.$inferSelect;

export type ModelWindow = Pick<ModelWindowRow, 'label' | 'used' | 'resetAt' | 'detail'>;

const MODEL_CALL_NAME_MAX = 256;

const nameOf = (row: NewModelCall) =>
  sql<string | null>`(select left(coalesce(${agents.name}, ${agents.host}), ${MODEL_CALL_NAME_MAX}) from ${agents} where ${agents.id} = ${row.agent} and ${agents.owner} = ${row.owner})`;

export async function recordModelCalls(db: Database, rows: NewModelCall[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(modelCalls).values(rows.map((row) => ({ ...row, agentName: nameOf(row) })));
}

export async function saveModelWindows(db: Database, owner: string, connection: string, windows: ModelWindow[], at: number): Promise<void> {
  await db.transaction(async (tx) => {
    const labels = windows.map((window) => window.label);
    const mine = and(eq(modelWindows.owner, owner), eq(modelWindows.connection, connection));
    await tx.delete(modelWindows).where(labels.length === 0 ? mine : and(mine, notInArray(modelWindows.label, labels)));
    if (windows.length === 0) return;
    await tx
      .insert(modelWindows)
      .values(windows.map((window) => ({ ...window, owner, connection, at })))
      .onConflictDoUpdate({
        target: [modelWindows.connection, modelWindows.label],
        set: { used: sql`excluded.used`, resetAt: sql`excluded.reset_at`, detail: sql`excluded.detail`, at: sql`excluded.at` },
        setWhere: eq(modelWindows.owner, owner),
      });
  });
}

export async function modelWindowsOf(db: Database, owner: string): Promise<ModelWindowRow[]> {
  return db.select().from(modelWindows).where(eq(modelWindows.owner, owner));
}
