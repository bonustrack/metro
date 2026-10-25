import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { AgentKeyMissing } from '../agent-auth.js';
import { routeNames, routeOf, type ModelRoute } from '../model-route.js';
import type { AgentKeyRow } from './agent-keys.js';
import type { Database } from './database.js';
import { hostIdIn, type ModelConnectionRow } from './models.js';
import { agentKeys, agents, modelConnections, modelRoutes } from './schema.js';

export type RouteSource = 'agent' | 'organization' | null;

export interface AgentModelSetup {
  route: ModelRoute | null;
  source: RouteSource;
  connections: ModelConnectionRow[];
  hostId: string;
}

export interface ModelDeliveryStore {
  setup: (identity: AgentKeyRow) => Promise<AgentModelSetup>;
}

export interface AgentOf {
  agent: string;
  owner: string;
}

async function holds(tx: Database, identity: AgentKeyRow): Promise<void> {
  const rows = await tx
    .select({ agent: agentKeys.agent })
    .from(agentKeys)
    .innerJoin(agents, and(eq(agents.id, agentKeys.agent), eq(agents.owner, agentKeys.owner)))
    .where(and(eq(agentKeys.agent, identity.agent), eq(agentKeys.owner, identity.owner), eq(agentKeys.keyId, identity.keyId), eq(agentKeys.signingKey, identity.signingKey), eq(agentKeys.enrolledAt, identity.enrolledAt)))
    .limit(1);
  if (rows.length === 0) throw new AgentKeyMissing();
}

async function setupIn(tx: Database, identity: AgentKeyRow): Promise<AgentModelSetup> {
  await holds(tx, identity);
  return agentSetupIn(tx, identity);
}

async function agentSetupIn(tx: Database, identity: AgentOf): Promise<AgentModelSetup> {
  const routes = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.owner, identity.owner), or(eq(modelRoutes.agent, identity.agent), isNull(modelRoutes.agent))));
  const own = routes.find((held) => held.agent === identity.agent);
  const chosen = own ?? routes.find((held) => held.agent === null);
  const route = chosen === undefined ? null : routeOf(chosen.route);
  const named = route === null ? [] : routeNames(route);
  const connections = named.length === 0 ? [] : await tx.select().from(modelConnections).where(and(eq(modelConnections.owner, identity.owner), inArray(modelConnections.id, named))).orderBy(modelConnections.id);
  const source: RouteSource = own !== undefined ? 'agent' : chosen === undefined ? null : 'organization';
  return { route, source, connections, hostId: await hostIdIn(tx, identity.owner) };
}

export function modelDeliveryStore(db: () => Database): ModelDeliveryStore {
  return {
    setup: (identity) => db().transaction((tx) => setupIn(tx, identity)),
  };
}

export function agentModelSetup(db: Database, identity: AgentOf): Promise<AgentModelSetup> {
  return db.transaction((tx) => agentSetupIn(tx, identity));
}
