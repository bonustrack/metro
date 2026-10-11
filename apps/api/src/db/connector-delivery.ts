import { and, eq, getTableColumns } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import type { SealedDelivery } from '@metro-labs/http/connector-delivery';
import { notEnrolled } from '../agents/auth.js';
import { agentKeyStore, type AgentKeyRow } from './agent-keys.js';
import type { Database } from './client.js';
import { editConnectorIn, type ConnectorEdit, type ConnectorRow } from './connectors.js';
import { eventRow } from './connector-events.js';
import { agents, agentKeys, connectorAgents, connectorEvents, connectors } from './schema.js';

export interface AssignedConnector {
  connector: ConnectorRow;
  assignmentPolicy: string | null;
}

export interface ConnectorDeliveryStore {
  assigned: (identity: AgentKeyRow) => Promise<AssignedConnector[]>;
  refresh: (identity: AgentKeyRow, id: string, at: string, edit: (row: AssignedConnector) => Promise<ConnectorEdit>) => Promise<void>;
  seal: (identity: AgentKeyRow, seal: (rows: AssignedConnector[]) => SealedDelivery) => Promise<SealedDelivery>;
}

function assignedQuery(db: Database, identity: AgentKeyRow, id?: string) {
  return db.select({ connector: getTableColumns(connectors), assignmentPolicy: connectorAgents.policy })
    .from(connectorAgents)
    .innerJoin(connectors, and(eq(connectors.id, connectorAgents.connector), eq(connectors.owner, identity.owner)))
    .innerJoin(agents, and(eq(agents.id, connectorAgents.agent), eq(agents.owner, identity.owner)))
    .innerJoin(agentKeys, and(eq(agentKeys.agent, agents.id), eq(agentKeys.owner, agents.owner)))
    .where(and(eq(agents.id, identity.agent), eq(agentKeys.keyId, identity.keyId), eq(agentKeys.signingKey, identity.signingKey), eq(agentKeys.sealingKey, identity.sealingKey), eq(agentKeys.enrolledAt, identity.enrolledAt), id === undefined ? undefined : eq(connectors.id, id)))
    .orderBy(connectors.id);
}

async function refreshIn(tx: Database, identity: AgentKeyRow, id: string, at: string, edit: (row: AssignedConnector) => Promise<ConnectorEdit>): Promise<void> {
  await editConnectorIn(tx, identity.owner, id, at, async (connector) => {
    const assigned = (await assignedQuery(tx, identity, id))[0];
    if (assigned === undefined) return { change: {}, event: null };
    return edit({ ...assigned, connector });
  });
}

async function sealIn(tx: Database, identity: AgentKeyRow, seal: (rows: AssignedConnector[]) => SealedDelivery): Promise<SealedDelivery> {
  const locked = await assignedQuery(tx, identity).for('update', { of: connectors });
  const agent = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, identity.agent), eq(agents.owner, identity.owner))).for('update');
  if (agent.length !== 1) throw notEnrolled();
  const current = await agentKeyStore(() => tx).find(identity.keyId);
  if (current === null || current.agent !== identity.agent || current.owner !== identity.owner || current.signingKey !== identity.signingKey || current.sealingKey !== identity.sealingKey || current.enrolledAt !== identity.enrolledAt) throw notEnrolled();
  const rows = await assignedQuery(tx, identity);
  const ids = new Set(locked.map((row) => row.connector.id));
  if (rows.some((row) => !ids.has(row.connector.id))) throw new ApiError('Connector assignments changed. Request a fresh snapshot.', 409);
  const sealed = seal(rows);
  if (rows.length > 0) {
    const at = new Date().toISOString();
    await tx.insert(connectorEvents).values(rows.map(({ connector }) => eventRow({ owner: identity.owner, connector: connector.id, agent: identity.agent, actor: `agent:${identity.agent}`, action: 'connector.delivered', detail: { name: connector.name } }, at)));
  }
  return sealed;
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
    seal: (identity, seal) => db().transaction((tx) => sealIn(tx, identity, seal)),
  };
}
