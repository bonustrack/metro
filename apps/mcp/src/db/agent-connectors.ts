import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from './client.js';
import { newId } from './ids.js';
import { isUniqueViolation } from './users.js';
import { ownedAgentOrThrow } from './agent-admin.js';
import { ConnectorError } from './connector-config.js';
import { agentConnectors, agents, connectors } from './schema.js';

export interface AgentConnectors {
  id: string;
  name: string;
  connectorIds: string[];
}

const nameClash = (name: string, agent: string): ConnectorError =>
  new ConnectorError(
    `the agent '${agent}' already has a connector named '${name}'`,
    409,
  );

async function collidingAgent(
  agentIds: string[],
  name: string,
  exceptConnectorId: string,
): Promise<string | null> {
  if (agentIds.length === 0) return null;
  const rows = await getDb()
    .select({ agent: agents.name })
    .from(agentConnectors)
    .innerJoin(connectors, eq(connectors.id, agentConnectors.connectorId))
    .innerJoin(agents, eq(agents.id, agentConnectors.agentId))
    .where(
      and(
        inArray(agentConnectors.agentId, agentIds),
        eq(connectors.name, name),
        ne(connectors.id, exceptConnectorId),
      ),
    )
    .limit(1);
  return rows[0]?.agent ?? null;
}

export async function assertRenameFreeOfClash(
  connectorId: string,
  name: string,
): Promise<void> {
  const rows = await getDb()
    .select({ agentId: agentConnectors.agentId })
    .from(agentConnectors)
    .where(eq(agentConnectors.connectorId, connectorId));
  const clash = await collidingAgent(
    rows.map((r) => r.agentId),
    name,
    connectorId,
  );
  if (clash !== null) throw nameClash(name, clash);
}

export async function connectorIdsOfAgent(agentId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ connectorId: agentConnectors.connectorId })
    .from(agentConnectors)
    .where(eq(agentConnectors.agentId, agentId))
    .orderBy(asc(agentConnectors.id));
  return rows.map((r) => r.connectorId);
}

export async function connectorIdsByAgent(
  agentIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (agentIds.length === 0) return out;
  const rows = await getDb()
    .select({
      agentId: agentConnectors.agentId,
      connectorId: agentConnectors.connectorId,
    })
    .from(agentConnectors)
    .where(inArray(agentConnectors.agentId, agentIds))
    .orderBy(asc(agentConnectors.id));
  for (const row of rows) {
    const list = out.get(row.agentId) ?? [];
    list.push(row.connectorId);
    out.set(row.agentId, list);
  }
  return out;
}

export async function agentConnectorsForEmail(
  email: string,
  agentId: string,
): Promise<AgentConnectors> {
  const { agent } = await ownedAgentOrThrow(email, agentId);
  return { ...agent, connectorIds: await connectorIdsOfAgent(agent.id) };
}

async function connectorNameIn(
  projectId: string,
  connectorId: string,
): Promise<string | null> {
  const rows = await getDb()
    .select({ name: connectors.name })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), eq(connectors.projectId, projectId)));
  return rows[0]?.name ?? null;
}

export async function addConnectorToAgentForEmail(
  email: string,
  agentId: string,
  connectorId: string,
): Promise<AgentConnectors> {
  const { agent, projectId } = await ownedAgentOrThrow(email, agentId);
  const name = await connectorNameIn(projectId, connectorId);
  if (name === null) throw new ConnectorError('no such connector', 404);
  const clash = await collidingAgent([agent.id], name, connectorId);
  if (clash !== null) throw nameClash(name, clash);
  try {
    await getDb()
      .insert(agentConnectors)
      .values({ id: newId(), agentId: agent.id, connectorId });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  return { ...agent, connectorIds: await connectorIdsOfAgent(agent.id) };
}

export async function removeConnectorFromAgentForEmail(
  email: string,
  agentId: string,
  connectorId: string,
): Promise<AgentConnectors> {
  const { agent } = await ownedAgentOrThrow(email, agentId);
  await getDb()
    .delete(agentConnectors)
    .where(
      and(
        eq(agentConnectors.agentId, agent.id),
        eq(agentConnectors.connectorId, connectorId),
      ),
    );
  return { ...agent, connectorIds: await connectorIdsOfAgent(agent.id) };
}
