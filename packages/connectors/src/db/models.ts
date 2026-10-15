import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { newId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { orgConnectionsOf, routeNames, routeOf, routeText, withoutConnection, type ModelRoute } from '../model-route.js';
import type { Database } from './database.js';
import { agents, modelConnections, modelHosts, modelRoutes } from './schema.js';

export type ModelConnectionRow = typeof modelConnections.$inferSelect;

export interface ModelChange {
  label?: string;
  model?: string;
  region?: string;
  zdr?: boolean;
  secret?: string | null;
  detail?: string | null;
}

export interface ModelEdit {
  change: ModelChange;
  credential?: boolean;
}

export interface RouteWrite {
  owner: string;
  agent: string | null;
  route: ModelRoute;
  actor: string;
  at: string;
}

export interface HeldRoute {
  agent: string | null;
  route: ModelRoute;
}

export interface OrgModels {
  connections: ModelConnectionRow[];
  routes: HeldRoute[];
}

export interface OrgModelStore {
  list: (owner: string) => Promise<OrgModels>;
  find: (owner: string, id: string) => Promise<ModelConnectionRow | null>;
  count: (owner: string) => Promise<number>;
  create: (row: ModelConnectionRow) => Promise<void>;
  edit: (owner: string, id: string, at: string, edit: (row: ModelConnectionRow) => ModelEdit | Promise<ModelEdit>) => Promise<ModelConnectionRow>;
  remove: (owner: string, id: string) => Promise<ModelConnectionRow>;
  setRoute: (write: RouteWrite) => Promise<ModelRoute>;
  removeRoute: (owner: string, agent: string | null) => Promise<boolean>;
  hostId: (owner: string) => Promise<string>;
}

const missing = (): ApiError => new ApiError('no such model connection', 404);
const owned = (owner: string, id: string): SQL | undefined => and(eq(modelConnections.id, id), eq(modelConnections.owner, owner));
const routeOwned = (owner: string, agent: string | null): SQL | undefined => and(eq(modelRoutes.owner, owner), agent === null ? isNull(modelRoutes.agent) : eq(modelRoutes.agent, agent));

async function lockModelConnection(tx: Database, owner: string, id: string): Promise<ModelConnectionRow> {
  const rows = await tx.select().from(modelConnections).where(owned(owner, id)).for('update');
  const row = rows[0];
  if (row === undefined) throw missing();
  return row;
}

async function editIn(tx: Database, owner: string, id: string, at: string, edit: (row: ModelConnectionRow) => ModelEdit | Promise<ModelEdit>): Promise<ModelConnectionRow> {
  const row = await lockModelConnection(tx, owner, id);
  const { change, credential } = await edit(row);
  if (Object.keys(change).length === 0 && credential !== true) return row;
  const saved = await tx
    .update(modelConnections)
    .set({ ...change, ...(credential === true ? { revision: row.revision + 1 } : {}), updatedAt: at })
    .where(owned(owner, id))
    .returning();
  return saved[0] ?? row;
}

async function removeIn(tx: Database, owner: string, id: string): Promise<ModelConnectionRow> {
  const row = await lockModelConnection(tx, owner, id);
  const routes = await tx.select().from(modelRoutes).where(eq(modelRoutes.owner, owner)).for('update');
  for (const held of routes) {
    const route = routeOf(held.route);
    if (route === null || !routeNames(route).includes(id)) continue;
    const next = withoutConnection(route, id);
    if (next === null) await tx.delete(modelRoutes).where(eq(modelRoutes.id, held.id));
    else await tx.update(modelRoutes).set({ route: routeText(next) }).where(eq(modelRoutes.id, held.id));
  }
  await tx.delete(modelConnections).where(owned(owner, id));
  return row;
}

async function upsertRoute(tx: Database, write: RouteWrite): Promise<void> {
  const route = routeText(write.route);
  const set = { owner: write.owner, route, updatedBy: write.actor, updatedAt: write.at };
  const values = { id: newId(), agent: write.agent, ...set };
  if (write.agent === null) await tx.insert(modelRoutes).values(values).onConflictDoUpdate({ target: modelRoutes.owner, targetWhere: sql`${modelRoutes.agent} IS NULL`, set });
  else await tx.insert(modelRoutes).values(values).onConflictDoUpdate({ target: modelRoutes.agent, targetWhere: sql`${modelRoutes.agent} IS NOT NULL`, set });
}

async function setRouteIn(tx: Database, write: RouteWrite): Promise<ModelRoute> {
  if (write.agent !== null) {
    const agent = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, write.agent), eq(agents.owner, write.owner))).for('update');
    if (agent.length === 0) throw new ApiError('no such agent in this organization', 404);
  }
  const named = orgConnectionsOf(write.route);
  if (named.length > 0) {
    const found = await tx.select({ id: modelConnections.id }).from(modelConnections).where(and(eq(modelConnections.owner, write.owner), inArray(modelConnections.id, named))).for('share');
    if (found.length !== named.length) throw new ApiError('A route can only name model connections of this organization.', 400);
  }
  await upsertRoute(tx, write);
  return write.route;
}

export async function hostIdIn(db: Database, owner: string): Promise<string> {
  const read = async (): Promise<string | undefined> => (await db.select().from(modelHosts).where(eq(modelHosts.owner, owner)).limit(1))[0]?.chatgptHostId;
  const held = await read();
  if (held !== undefined) return held;
  await db.insert(modelHosts).values({ owner, chatgptHostId: `urn:uuid:${randomUUID()}` }).onConflictDoNothing();
  const made = await read();
  if (made === undefined) throw new ApiError('Metro could not keep the organization’s ChatGPT host id.', 503);
  return made;
}

async function listIn(db: Database, owner: string): Promise<OrgModels> {
  const connections = await db.select().from(modelConnections).where(eq(modelConnections.owner, owner)).orderBy(modelConnections.createdAt, modelConnections.id);
  const defaults = await db.select({ agent: modelRoutes.agent, route: modelRoutes.route }).from(modelRoutes).where(routeOwned(owner, null));
  const overrides = await db
    .select({ agent: modelRoutes.agent, route: modelRoutes.route })
    .from(modelRoutes)
    .innerJoin(agents, and(eq(agents.id, modelRoutes.agent), eq(agents.owner, owner)))
    .where(eq(modelRoutes.owner, owner))
    .orderBy(modelRoutes.agent);
  const routes = [...defaults, ...overrides].flatMap((held) => {
    const route = routeOf(held.route);
    return route === null ? [] : [{ agent: held.agent, route }];
  });
  return { connections, routes };
}

export function orgModelStore(db: () => Database): OrgModelStore {
  return {
    list: (owner) => listIn(db(), owner),
    find: async (owner, id) => (await db().select().from(modelConnections).where(owned(owner, id)).limit(1))[0] ?? null,
    count: (owner) => db().$count(modelConnections, eq(modelConnections.owner, owner)),
    create: async (row) => {
      await db().insert(modelConnections).values(row);
    },
    edit: (owner, id, at, edit) => db().transaction((tx) => editIn(tx, owner, id, at, edit)),
    remove: (owner, id) => db().transaction((tx) => removeIn(tx, owner, id)),
    setRoute: (write) => db().transaction((tx) => setRouteIn(tx, write)),
    removeRoute: async (owner, agent) => (await db().delete(modelRoutes).where(routeOwned(owner, agent)).returning({ id: modelRoutes.id })).length > 0,
    hostId: (owner) => hostIdIn(db(), owner),
  };
}
