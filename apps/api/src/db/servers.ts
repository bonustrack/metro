import { and, asc, eq } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { getDb } from './client.js';
import { newId, parseId } from '@metro-labs/core/ids';
import { agents } from './schema.js';
import { normalizeAddress } from '@metro-labs/core/address';
import { parseServerHost, parseServerName, type ServerEntry } from '../server-types.js';
import { parseAvatar } from '../avatar.js';

export class ServerListError extends ApiError {}

const missing = (): ServerListError => new ServerListError('no such server', 404);

function ownerOf(subject: string): string {
  const address = normalizeAddress(subject);
  if (address === null) throw new ServerListError('the server list needs a signed identity', 403);
  return address;
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
