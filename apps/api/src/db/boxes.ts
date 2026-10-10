import { and, eq, ne } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import type { Database } from './client.js';
import { eventRow, type ConnectorEvent } from './connector-events.js';
import { agents, boxKeys, connectorEvents } from './schema.js';

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

function enrollmentEvents(row: BoxKeyRow, replaced: string | undefined, moved: { agent: string; owner: string }[]): ConnectorEvent[] {
  const detail: Record<string, string> = replaced === undefined || replaced === row.keyId ? { keyId: row.keyId } : { keyId: row.keyId, replaced };
  return [
    ...moved.map((gone) => ({ owner: gone.owner, agent: gone.agent, actor: 'metro', action: 'box.unenrolled', detail: { keyId: row.keyId, reason: 'enrolled as another agent' } })),
    { owner: row.owner, agent: row.agent, actor: `user:${row.enrolledBy}`, action: 'box.enrolled', detail },
  ];
}

export function boxKeyStore(db: () => Database): BoxKeyStore {
  return {
    listed: async (owner, agent) => {
      const rows = await db().select({ id: agents.id }).from(agents).where(ownedBy(owner, agent)).limit(1);
      return rows.length > 0;
    },
    enroll: async (row) => {
      await db().transaction(async (tx) => {
        const listed = await tx.select({ id: agents.id }).from(agents).where(ownedBy(row.owner, row.agent)).for('update');
        if (listed.length === 0) throw new ApiError('This agent is no longer in this organization. Enroll it again from its page.', 404);
        const moved = await tx.delete(boxKeys).where(and(eq(boxKeys.keyId, row.keyId), ne(boxKeys.agent, row.agent))).returning({ agent: boxKeys.agent, owner: boxKeys.owner });
        const before = await tx.select({ keyId: boxKeys.keyId }).from(boxKeys).where(eq(boxKeys.agent, row.agent));
        const { agent, ...changes } = row;
        await tx.insert(boxKeys).values(row).onConflictDoUpdate({ target: boxKeys.agent, set: changes });
        const events = enrollmentEvents({ agent, ...changes }, before[0]?.keyId, moved);
        await tx.insert(connectorEvents).values(events.map((event) => eventRow(event, row.enrolledAt)));
      });
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
