import { and, eq, ne } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import type { Database } from './client.js';
import { eventRow } from './connector-events.js';
import { isUniqueViolation } from './errors.js';
import { agents, boxKeys, connectorAgents, connectorEvents } from './schema.js';

export interface BoxKeyRow {
  agent: string;
  owner: string;
  keyId: string;
  signingKey: string;
  sealingKey: string;
  enrolledBy: string;
  enrolledAt: string;
}

export interface BoxKeyStore {
  listed: (owner: string, agent: string) => Promise<boolean>;
  enroll: (row: BoxKeyRow) => Promise<void>;
  find: (keyId: string) => Promise<BoxKeyRow | null>;
}

const columns = {
  agent: boxKeys.agent,
  owner: boxKeys.owner,
  keyId: boxKeys.keyId,
  signingKey: boxKeys.signingKey,
  sealingKey: boxKeys.sealingKey,
  enrolledBy: boxKeys.enrolledBy,
  enrolledAt: boxKeys.enrolledAt,
};

const ownedBy = (owner: string, agent: string) => and(eq(agents.id, agent), eq(agents.owner, owner));

const keyInUse = (): ApiError => new ApiError('This box key is already enrolled as another agent. Enroll again from the box to give it a new key.', 409);

async function enrollIn(tx: Database, row: BoxKeyRow): Promise<void> {
  const listed = await tx.select({ id: agents.id }).from(agents).where(ownedBy(row.owner, row.agent)).for('update');
  if (listed.length === 0) throw new ApiError('This agent is no longer in this organization. Enroll it again from its page.', 404);
  const elsewhere = await tx.select({ agent: boxKeys.agent }).from(boxKeys).where(and(eq(boxKeys.keyId, row.keyId), ne(boxKeys.agent, row.agent)));
  if (elsewhere.length > 0) throw keyInUse();
  const before = await tx.select({ keyId: boxKeys.keyId }).from(boxKeys).where(eq(boxKeys.agent, row.agent));
  const { agent, ...changes } = row;
  await tx.insert(boxKeys).values(row).onConflictDoUpdate({ target: boxKeys.agent, set: changes });
  const replaced = before[0]?.keyId;
  const detail: Record<string, string> = replaced === undefined || replaced === row.keyId ? { keyId: row.keyId } : { keyId: row.keyId, replaced };
  await tx.insert(connectorEvents).values(eventRow({ owner: row.owner, agent, actor: `user:${row.enrolledBy}`, action: 'box.enrolled', detail }, row.enrolledAt));
}

export async function leaveOrganization(tx: Database, agent: string, owner: string, at: string): Promise<void> {
  await tx.delete(connectorAgents).where(eq(connectorAgents.agent, agent));
  const gone = await tx.delete(boxKeys).where(eq(boxKeys.agent, agent)).returning({ keyId: boxKeys.keyId });
  const key = gone[0];
  if (key === undefined) return;
  await tx.insert(connectorEvents).values(eventRow({ owner, agent, actor: 'metro', action: 'box.unenrolled', detail: { keyId: key.keyId, reason: 'the agent moved to another organization' } }, at));
}

export function boxKeyStore(db: () => Database): BoxKeyStore {
  return {
    listed: async (owner, agent) => {
      const rows = await db().select({ id: agents.id }).from(agents).where(ownedBy(owner, agent)).limit(1);
      return rows.length > 0;
    },
    enroll: async (row) => {
      try {
        await db().transaction((tx) => enrollIn(tx, row));
      } catch (err) {
        if (isUniqueViolation(err)) throw keyInUse();
        throw err;
      }
    },
    find: async (keyId) => {
      const rows = await db()
        .select(columns)
        .from(boxKeys)
        .innerJoin(agents, and(eq(agents.id, boxKeys.agent), eq(agents.owner, boxKeys.owner)))
        .where(eq(boxKeys.keyId, keyId))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
