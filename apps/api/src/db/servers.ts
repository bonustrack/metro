import { and, asc, eq } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { getDb } from './client.js';
import { newId, parseId } from '@metro-labs/core/ids';
import { agents } from './schema.js';
import { parseServerHost, parseServerName, type ServerEntry } from '../server-types.js';
import { parseAvatar } from '../avatar.js';
import { isOrganizationId, type Session } from '@metro-labs/http/workos-token';
import { userOrganizations, type WorkosConfig } from '../auth/workos.js';

export class ServerListError extends ApiError {}

const missing = (): ServerListError => new ServerListError('no such server', 404);

function ownerOf(subject: string): string {
  if (!isOrganizationId(subject)) throw new ServerListError('the agent list belongs to an organization; sign in first', 403);
  return subject;
}

function idOf(raw: string): string {
  const id = parseId(raw);
  if (id === null) throw missing();
  return id;
}

interface Row {
  id: string;
  host: string;
  name: string | null;
  addedAt: string;
  instanceId: string | null;
  launchedAt: string | null;
  avatar: string | null;
}

const entryOf = (row: Row): ServerEntry => ({
  id: row.id,
  host: row.host,
  name: row.name,
  addedAt: row.addedAt,
  instanceId: row.instanceId,
  launchedAt: row.launchedAt,
  avatar: row.avatar,
});

const columns = {
  id: agents.id,
  host: agents.host,
  name: agents.name,
  addedAt: agents.addedAt,
  instanceId: agents.instanceId,
  launchedAt: agents.launchedAt,
  avatar: agents.avatar,
};

export async function listServersForOwner(subject: string): Promise<ServerEntry[]> {
  const owner = ownerOf(subject);
  const rows = await getDb().select(columns).from(agents).where(eq(agents.owner, owner)).orderBy(asc(agents.addedAt));
  return rows.map(entryOf);
}

export async function addServerForOwner(subject: string, body: unknown): Promise<ServerEntry> {
  const owner = ownerOf(subject);
  const host = parseServerHost(isRecord(body) && typeof body.host === 'string' ? body.host : '');
  if (host === null) throw new ServerListError('host is not a server address', 400);
  const name = parseServerName(isRecord(body) ? body.name : undefined);
  const db = getDb();
  const held = await db.select(columns).from(agents).where(and(eq(agents.owner, owner), eq(agents.host, host)));
  const row = held[0];
  if (row !== undefined) {
    if (name === null) return entryOf(row);
    await db.update(agents).set({ name }).where(eq(agents.id, row.id));
    return entryOf({ ...row, name });
  }
  const next = { id: newId(), owner, host, name, addedAt: new Date().toISOString(), instanceId: null, launchedAt: null, avatar: null };
  await db.insert(agents).values(next);
  return entryOf(next);
}

export interface LaunchRecord {
  host: string;
  name: string;
  instanceId: string;
  region: string;
}

export async function addLaunchedServer(subject: string, launch: LaunchRecord): Promise<ServerEntry> {
  const owner = ownerOf(subject);
  const host = parseServerHost(launch.host);
  if (host === null) throw new ServerListError('host is not a server address', 400);
  const next = {
    id: newId(),
    owner,
    host,
    name: parseServerName(launch.name),
    addedAt: new Date().toISOString(),
    instanceId: launch.instanceId,
    launchRegion: launch.region,
    launchedAt: new Date().toISOString(),
    avatar: null,
  };
  await getDb().insert(agents).values(next);
  return entryOf(next);
}

export interface ServerLaunch {
  instanceId: string;
  region: string;
}

export async function launchForOwner(subject: string, rawId: string): Promise<ServerLaunch> {
  const owner = ownerOf(subject);
  const id = idOf(rawId);
  const rows = await getDb()
    .select({ instanceId: agents.instanceId, region: agents.launchRegion })
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.owner, owner)));
  const row = rows[0];
  if (row === undefined) throw missing();
  if (row.instanceId === null || row.region === null)
    throw new ServerListError('metro did not launch that server, so it has no boot log', 400);
  return { instanceId: row.instanceId, region: row.region };
}

export async function renameServerForOwner(subject: string, rawId: string, body: unknown): Promise<ServerEntry> {
  const owner = ownerOf(subject);
  const id = idOf(rawId);
  const name = parseServerName(isRecord(body) ? body.name : undefined);
  const rows = await getDb()
    .update(agents)
    .set({ name })
    .where(and(eq(agents.id, id), eq(agents.owner, owner)))
    .returning(columns);
  const row = rows[0];
  if (row === undefined) throw missing();
  return entryOf(row);
}

export async function setAvatarForOwner(subject: string, rawId: string, body: unknown): Promise<ServerEntry> {
  const owner = ownerOf(subject);
  const id = idOf(rawId);
  const avatar = parseAvatar(isRecord(body) ? body.avatar : undefined);
  const rows = await getDb()
    .update(agents)
    .set({ avatar })
    .where(and(eq(agents.id, id), eq(agents.owner, owner)))
    .returning(columns);
  const row = rows[0];
  if (row === undefined) throw missing();
  return entryOf(row);
}

const isUnique = (err: unknown): boolean => isRecord(err) && err.code === '23505';

function moveTarget(session: Session, body: unknown): { from: string; to: string } {
  const from = ownerOf(session.organization ?? '');
  if (session.role !== 'admin') throw new ServerListError('this needs the admin role in your organization', 403);
  const to = isRecord(body) && typeof body.organization === 'string' ? body.organization.trim() : '';
  if (!isOrganizationId(to)) throw new ServerListError('organization must be an organization id', 400);
  if (to === from) throw new ServerListError('the agent is already in that organization', 409);
  return { from, to };
}

async function assertAdminOf(cfg: WorkosConfig | null, session: Session, to: string): Promise<void> {
  if (cfg === null) throw new ServerListError('sign-in is not configured on this server', 503);
  const target = (await userOrganizations(cfg, session.userId)).find((o) => o.id === to);
  if (target === undefined) throw new ServerListError('you are not a member of that organization', 404);
  if (target.role !== 'admin') throw new ServerListError('you need the admin role in that organization too', 403);
}

async function changeOwner(id: string, from: string, to: string): Promise<ServerEntry> {
  try {
    const rows = await getDb().update(agents).set({ owner: to }).where(and(eq(agents.id, id), eq(agents.owner, from))).returning(columns);
    const row = rows[0];
    if (row === undefined) throw missing();
    return entryOf(row);
  } catch (err) {
    if (isUnique(err)) throw new ServerListError('that organization already lists an agent at this address', 409);
    throw err;
  }
}

export async function moveServerForOwner(session: Session, rawId: string, body: unknown, cfg: WorkosConfig | null): Promise<ServerEntry> {
  const id = idOf(rawId);
  const { from, to } = moveTarget(session, body);
  await assertAdminOf(cfg, session, to);
  return changeOwner(id, from, to);
}

export async function deleteServerForOwner(subject: string, rawId: string): Promise<{ id: string; host: string }> {
  const owner = ownerOf(subject);
  const id = idOf(rawId);
  const gone = await getDb()
    .delete(agents)
    .where(and(eq(agents.id, id), eq(agents.owner, owner)))
    .returning({ id: agents.id, host: agents.host });
  const row = gone[0];
  if (row === undefined) throw missing();
  return row;
}
