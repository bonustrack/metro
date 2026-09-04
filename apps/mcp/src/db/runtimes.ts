import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from './client.js';
import { newId } from './ids.js';
import { agents, runtimes } from './schema.js';
import { ApiError } from '../daemon/api-error.js';

export interface RuntimeLease {
  runtimeId: string;
  agentId: string;
  label: string;
}

export interface RuntimeView {
  id: string;
  label: string;
  lastSeenAt: string | null;
}

const nowIso = (): string => new Date().toISOString();

const stale = (): ApiError =>
  new ApiError('this runtime no longer holds the agent', 409);

export async function claimRuntime(
  agentId: string,
  label: string,
): Promise<RuntimeLease> {
  const db = getDb();
  const id = newId();
  return db.transaction(async (tx) => {
    await tx
      .insert(runtimes)
      .values({ id, agentId, label, createdAt: nowIso(), lastSeenAt: nowIso() });
    const rows = await tx
      .update(agents)
      .set({ runtimeId: id })
      .where(eq(agents.id, agentId))
      .returning({ id: agents.id });
    if (rows[0] === undefined) throw new ApiError('no such agent', 404);
    return { runtimeId: id, agentId, label };
  });
}

export async function fenceRuntime(
  runtimeId: string,
  agentId: string,
): Promise<void> {
  const rows = await getDb()
    .select({ holder: agents.runtimeId })
    .from(agents)
    .innerJoin(runtimes, eq(runtimes.id, agents.runtimeId))
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.runtimeId, runtimeId),
        isNull(runtimes.revokedAt),
      ),
    );
  if (rows[0] === undefined) throw stale();
}

export async function touchRuntime(runtimeId: string): Promise<void> {
  await getDb()
    .update(runtimes)
    .set({ lastSeenAt: nowIso() })
    .where(eq(runtimes.id, runtimeId));
}

export async function releaseRuntime(agentId: string): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .update(runtimes)
      .set({ revokedAt: nowIso() })
      .where(and(eq(runtimes.agentId, agentId), isNull(runtimes.revokedAt)));
    await tx
      .update(agents)
      .set({ runtimeId: null })
      .where(eq(agents.id, agentId));
  });
}

export async function runtimeLabels(
  agentIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of agentIds) {
    const found = await runtimeFor(id);
    if (found !== null) out.set(id, found.label);
  }
  return out;
}

async function runtimeFor(agentId: string): Promise<RuntimeView | null> {
  const rows = await getDb()
    .select({
      id: runtimes.id,
      label: runtimes.label,
      lastSeenAt: runtimes.lastSeenAt,
    })
    .from(runtimes)
    .innerJoin(agents, eq(agents.runtimeId, runtimes.id))
    .where(and(eq(agents.id, agentId), isNull(runtimes.revokedAt)));
  return rows[0] ?? null;
}
