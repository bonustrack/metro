import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import type { Database } from './database.js';
import { isUniqueViolation } from './errors.js';
import { agents, agentKeys, agentTokens, connectorAgents, modelRoutes } from './schema.js';

export interface AgentKeyRow {
  agent: string;
  owner: string;
  keyId: string;
  signingKey: string;
  enrolledBy: string;
  enrolledAt: string;
}

export interface AgentKeyStore {
  listed: (owner: string, agent: string) => Promise<boolean>;
  enroll: (row: AgentKeyRow) => Promise<void>;
  find: (keyId: string) => Promise<AgentKeyRow | null>;
}

export const agentKeyColumns = {
  agent: agentKeys.agent,
  owner: agentKeys.owner,
  keyId: agentKeys.keyId,
  signingKey: agentKeys.signingKey,
  enrolledBy: agentKeys.enrolledBy,
  enrolledAt: agentKeys.enrolledAt,
};

const ownedBy = (owner: string, agent: string) => and(eq(agents.id, agent), eq(agents.owner, owner));

const keyInUse = (): ApiError => new ApiError('This agent key is already enrolled as another agent. Enroll again from the agent to give it a new key.', 409);

async function enrollIn(tx: Database, row: AgentKeyRow): Promise<void> {
  const listed = await tx.select({ id: agents.id, host: agents.host }).from(agents).where(ownedBy(row.owner, row.agent)).for('update');
  if (listed.length === 0) throw new ApiError('This agent is no longer in this organization. Enroll it again from its page.', 404);
  if (listed[0]?.host === null) throw new ApiError('This agent has no server, so no server can enroll as it.', 409);
  const elsewhere = await tx.select({ agent: agentKeys.agent }).from(agentKeys).where(and(eq(agentKeys.keyId, row.keyId), ne(agentKeys.agent, row.agent)));
  if (elsewhere.length > 0) throw keyInUse();
  const { owner, keyId, signingKey, enrolledBy, enrolledAt } = row;
  await tx.insert(agentKeys).values(row).onConflictDoUpdate({ target: agentKeys.agent, set: { owner, keyId, signingKey, enrolledBy, enrolledAt, mcpTokenHash: null } });
}

export async function leaveOrganization(tx: Database, agent: string): Promise<void> {
  await tx.delete(connectorAgents).where(eq(connectorAgents.agent, agent));
  await tx.delete(modelRoutes).where(eq(modelRoutes.agent, agent));
  await tx.delete(agentKeys).where(eq(agentKeys.agent, agent));
  await tx.delete(agentTokens).where(eq(agentTokens.agent, agent));
}

export function agentKeyStore(db: () => Database): AgentKeyStore {
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
        .select(agentKeyColumns)
        .from(agentKeys)
        .innerJoin(agents, and(eq(agents.id, agentKeys.agent), eq(agents.owner, agentKeys.owner), isNotNull(agents.host)))
        .where(eq(agentKeys.keyId, keyId))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
