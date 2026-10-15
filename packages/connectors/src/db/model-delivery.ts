import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { newId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { AgentKeyMissing } from '../agent-auth.js';
import { orgConnectionsOf, routeOf, type ModelRoute } from '../model-route.js';
import type { AgentKeyRow } from './agent-keys.js';
import type { Database } from './database.js';
import { hostIdIn, upsertRoute, type ModelConnectionRow } from './models.js';
import { agentKeys, agents, modelConnections, modelRoutes } from './schema.js';

export type RouteSource = 'agent' | 'organization' | null;

export interface AgentModelSetup {
  route: ModelRoute | null;
  source: RouteSource;
  connections: ModelConnectionRow[];
  hostId: string;
}

export interface ImportRow {
  importId: string;
  provider: string;
  label: string;
  model: string;
  region: string;
  zdr: boolean;
  secret: (row: { owner: string; id: string }) => string | null;
  detail: string | null;
}

export interface ImportInput {
  rows: ImportRow[];
  route: (ids: Map<string, string>) => ModelRoute | null;
  at: string;
  limit: number;
}

export interface ModelDeliveryStore {
  setup: (identity: AgentKeyRow) => Promise<AgentModelSetup>;
  import: (identity: AgentKeyRow, input: ImportInput) => Promise<Map<string, string>>;
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
  const routes = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.owner, identity.owner), or(eq(modelRoutes.agent, identity.agent), isNull(modelRoutes.agent))));
  const own = routes.find((held) => held.agent === identity.agent);
  const chosen = own ?? routes.find((held) => held.agent === null);
  const route = chosen === undefined ? null : routeOf(chosen.route);
  const named = route === null ? [] : orgConnectionsOf(route);
  const connections = named.length === 0 ? [] : await tx.select().from(modelConnections).where(and(eq(modelConnections.owner, identity.owner), inArray(modelConnections.id, named))).orderBy(modelConnections.id);
  const source: RouteSource = own !== undefined ? 'agent' : chosen === undefined ? null : 'organization';
  return { route, source, connections, hostId: await hostIdIn(tx, identity.owner) };
}

async function importedId(tx: Database, identity: AgentKeyRow, importId: string): Promise<string | null> {
  const rows = await tx.select({ id: modelConnections.id, owner: modelConnections.owner }).from(modelConnections).where(and(eq(modelConnections.importAgent, identity.agent), eq(modelConnections.importId, importId))).limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  if (row.owner !== identity.owner) throw new ApiError('This connection was imported into another organization.', 409);
  return row.id;
}

async function insertImported(tx: Database, identity: AgentKeyRow, row: ImportRow, at: string): Promise<string> {
  const id = newId();
  const made: ModelConnectionRow = {
    id, owner: identity.owner, provider: row.provider, label: row.label, model: row.model, region: row.region, zdr: row.zdr,
    secret: row.secret({ owner: identity.owner, id }), detail: row.detail, revision: 1, importAgent: identity.agent, importId: row.importId,
    createdBy: `agent:${identity.agent}`, createdAt: at, updatedAt: at,
  };
  const saved = await tx.insert(modelConnections).values(made).onConflictDoNothing({ target: [modelConnections.importAgent, modelConnections.importId] }).returning({ id: modelConnections.id });
  const kept = saved[0]?.id ?? (await importedId(tx, identity, row.importId));
  if (kept === null) throw new ApiError('Metro could not keep an imported model connection. Try again.', 503);
  return kept;
}

async function importIn(tx: Database, identity: AgentKeyRow, input: ImportInput): Promise<Map<string, string>> {
  await holds(tx, identity);
  const ids = new Map<string, string>();
  for (const row of input.rows) {
    const held = await importedId(tx, identity, row.importId);
    if (held !== null) ids.set(row.importId, held);
  }
  const fresh = input.rows.filter((row) => !ids.has(row.importId));
  if (fresh.length > 0 && (await tx.$count(modelConnections, eq(modelConnections.owner, identity.owner))) + fresh.length > input.limit)
    throw new ApiError(`An organization keeps at most ${String(input.limit)} model connections. Remove one on the Models page, then the agent imports its setup again.`, 409);
  for (const row of fresh) ids.set(row.importId, await insertImported(tx, identity, row, input.at));
  const route = input.route(ids);
  if (route !== null) await upsertRoute(tx, { owner: identity.owner, agent: identity.agent, route, actor: `agent:${identity.agent}`, at: input.at });
  return ids;
}

export function modelDeliveryStore(db: () => Database): ModelDeliveryStore {
  return {
    setup: (identity) => db().transaction((tx) => setupIn(tx, identity)),
    import: (identity, input) => db().transaction((tx) => importIn(tx, identity, input)),
  };
}
