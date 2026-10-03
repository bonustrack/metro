import { and, asc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { getDb } from './client.js';
import { isUniqueViolation } from './errors.js';
import { agents, awsConnections, awsExternalIds } from './schema.js';
import type { AwsAccount } from '../aws/access.js';

export interface Connection {
  id: string;
  accountId: string;
  roleArn: string;
  addedAt: string;
}

export interface Placement {
  instanceId: string;
  region: string;
  account: AwsAccount | null;
}

export interface Placed {
  instanceId: string | null;
  region: string | null;
  connection: string | null;
  roleArn: string | null;
  externalId: string | null;
}

export interface Linked {
  agentId: string;
  connection: string;
  instanceId: string;
}

export interface LinkTarget {
  connection: string;
  region: string;
  instanceId: string;
}

export const placedColumns = {
  instanceId: agents.instanceId,
  region: agents.launchRegion,
  connection: agents.awsConnection,
  roleArn: awsConnections.roleArn,
  externalId: awsExternalIds.externalId,
};

export const connectionJoin = and(eq(awsConnections.id, agents.awsConnection), eq(awsConnections.owner, agents.owner));
export const externalIdJoin = eq(awsExternalIds.owner, agents.owner);

export function placementOf(row: Placed): Placement | null {
  const { instanceId, region, connection, roleArn, externalId } = row;
  if (instanceId === null || region === null) return null;
  if (connection === null) return { instanceId, region, account: null };
  if (roleArn === null || externalId === null) return null;
  return { instanceId, region, account: { connection, roleArn, externalId } };
}

const connectionColumns = { id: awsConnections.id, accountId: awsConnections.accountId, roleArn: awsConnections.roleArn, addedAt: awsConnections.addedAt };

async function externalId(owner: string): Promise<string | null> {
  const rows = await getDb().select({ externalId: awsExternalIds.externalId }).from(awsExternalIds).where(eq(awsExternalIds.owner, owner)).limit(1);
  return rows[0]?.externalId ?? null;
}

async function ensureExternalId(owner: string, fresh: string): Promise<string> {
  await getDb().insert(awsExternalIds).values({ owner, externalId: fresh, createdAt: new Date().toISOString() }).onConflictDoNothing({ target: awsExternalIds.owner });
  const held = await externalId(owner);
  if (held === null) throw new ApiError('could not keep the external id of this organization', 500);
  return held;
}

const list = (owner: string): Promise<Connection[]> =>
  getDb().select(connectionColumns).from(awsConnections).where(eq(awsConnections.owner, owner)).orderBy(asc(awsConnections.addedAt));

async function find(owner: string, id: string): Promise<Connection | null> {
  const rows = await getDb().select(connectionColumns).from(awsConnections).where(and(eq(awsConnections.id, id), eq(awsConnections.owner, owner)));
  return rows[0] ?? null;
}

async function add(owner: string, row: Connection): Promise<Connection> {
  try {
    await getDb().insert(awsConnections).values({ ...row, owner });
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(`AWS account ${row.accountId} is already connected to this organization`, 409);
    throw err;
  }
}

async function remove(owner: string, id: string): Promise<number> {
  return getDb().transaction(async (tx) => {
    const unlinked = await tx
      .update(agents)
      .set({ instanceId: null, launchRegion: null, awsConnection: null })
      .where(and(eq(agents.owner, owner), eq(agents.awsConnection, id)))
      .returning({ id: agents.id });
    const gone = await tx.delete(awsConnections).where(and(eq(awsConnections.id, id), eq(awsConnections.owner, owner))).returning({ id: awsConnections.id });
    if (gone.length === 0) throw new ApiError('no such AWS account', 404);
    return unlinked.length;
  });
}

async function linked(owner: string): Promise<Linked[]> {
  const rows = await getDb()
    .select({ agentId: agents.id, connection: agents.awsConnection, instanceId: agents.instanceId })
    .from(agents)
    .where(and(eq(agents.owner, owner), isNotNull(agents.awsConnection), isNotNull(agents.instanceId)));
  return rows.flatMap((r) => (r.connection === null || r.instanceId === null ? [] : [{ agentId: r.agentId, connection: r.connection, instanceId: r.instanceId }]));
}

async function link(owner: string, agentId: string, target: LinkTarget): Promise<boolean> {
  const rows = await getDb()
    .update(agents)
    .set({ instanceId: target.instanceId, launchRegion: target.region, awsConnection: target.connection })
    .where(and(eq(agents.id, agentId), eq(agents.owner, owner), or(isNull(agents.instanceId), isNotNull(agents.awsConnection))))
    .returning({ id: agents.id });
  return rows.length > 0;
}

async function unlink(owner: string, agentId: string): Promise<boolean> {
  const rows = await getDb()
    .update(agents)
    .set({ instanceId: null, launchRegion: null, awsConnection: null })
    .where(and(eq(agents.id, agentId), eq(agents.owner, owner), isNotNull(agents.awsConnection)))
    .returning({ id: agents.id });
  return rows.length > 0;
}

export interface MetroServer {
  id: string;
  owner: string;
  name: string | null;
  instanceId: string;
  region: string;
}

export async function metroServers(): Promise<MetroServer[]> {
  const rows = await getDb()
    .select({ id: agents.id, owner: agents.owner, name: agents.name, instanceId: agents.instanceId, region: agents.launchRegion })
    .from(agents)
    .where(and(isNull(agents.awsConnection), isNotNull(agents.instanceId), isNotNull(agents.launchRegion)))
    .orderBy(asc(agents.addedAt));
  return rows.flatMap((r) => (r.instanceId === null || r.region === null ? [] : [{ ...r, instanceId: r.instanceId, region: r.region }]));
}

export interface AwsStore {
  externalId: (owner: string) => Promise<string | null>;
  ensureExternalId: (owner: string, fresh: string) => Promise<string>;
  list: (owner: string) => Promise<Connection[]>;
  find: (owner: string, id: string) => Promise<Connection | null>;
  add: (owner: string, row: Connection) => Promise<Connection>;
  remove: (owner: string, id: string) => Promise<number>;
  linked: (owner: string) => Promise<Linked[]>;
  link: (owner: string, agentId: string, target: LinkTarget) => Promise<boolean>;
  unlink: (owner: string, agentId: string) => Promise<boolean>;
}

export const dbAws: AwsStore = { externalId, ensureExternalId, list, find, add, remove, linked, link, unlink };
