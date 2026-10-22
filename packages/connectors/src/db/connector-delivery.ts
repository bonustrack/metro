import { and, eq, exists, getTableColumns, isNull, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import type { AgentKeyRow } from './agent-keys.js';
import { isTokenIdentity, type AgentTokenIdentity } from './agent-tokens.js';
import type { Database } from './database.js';
import { editConnectorIn, type ConnectorEdit, type ConnectorRow } from './connectors.js';
import { agents, agentKeys, agentTokens, connectorAgents, connectors } from './schema.js';

export type DeliveryIdentity = AgentKeyRow | AgentTokenIdentity;

export interface AssignedConnector {
  connector: ConnectorRow;
  assignmentPolicy: string | null;
}

export interface ConnectorDeliveryStore {
  assigned: (identity: DeliveryIdentity) => Promise<AssignedConnector[]>;
  refresh: (identity: DeliveryIdentity, id: string, at: string, edit: (row: AssignedConnector) => Promise<ConnectorEdit>) => Promise<void>;
}

function credentialHeld(db: Database, identity: DeliveryIdentity): SQL {
  const one = { one: sql`1` };
  if (isTokenIdentity(identity))
    return exists(db.select(one).from(agentTokens).where(and(eq(agentTokens.id, identity.tokenId), eq(agentTokens.agent, agents.id), eq(agentTokens.owner, agents.owner), isNull(agentTokens.revokedAt))));
  return exists(
    db.select(one).from(agentKeys).where(and(
      eq(agentKeys.agent, agents.id),
      eq(agentKeys.owner, agents.owner),
      eq(agentKeys.keyId, identity.keyId),
      eq(agentKeys.signingKey, identity.signingKey),
      eq(agentKeys.enrolledAt, identity.enrolledAt),
    )),
  );
}

function assignedQuery(db: Database, identity: DeliveryIdentity, id?: string) {
  return db.select({ connector: getTableColumns(connectors), assignmentPolicy: connectorAgents.policy })
    .from(connectorAgents)
    .innerJoin(connectors, and(eq(connectors.id, connectorAgents.connector), eq(connectors.owner, identity.owner)))
    .innerJoin(agents, and(eq(agents.id, connectorAgents.agent), eq(agents.owner, identity.owner)))
    .where(and(eq(agents.id, identity.agent), credentialHeld(db, identity), id === undefined ? undefined : eq(connectors.id, id)))
    .orderBy(connectors.id);
}

async function refreshIn(tx: Database, identity: DeliveryIdentity, id: string, at: string, edit: (row: AssignedConnector) => Promise<ConnectorEdit>): Promise<void> {
  await editConnectorIn(tx, identity.owner, id, at, async (connector) => {
    const assigned = (await assignedQuery(tx, identity, id))[0];
    if (assigned === undefined) return { change: {} };
    return edit({ ...assigned, connector });
  });
}

export function connectorDeliveryStore(db: () => Database): ConnectorDeliveryStore {
  return {
    assigned: (identity) => assignedQuery(db(), identity),
    refresh: async (identity, id, at, edit) => {
      try {
        await db().transaction((tx) => refreshIn(tx, identity, id, at, edit));
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      }
    },
  };
}
