import { and, asc, eq } from 'drizzle-orm';
import { ApiError } from '../daemon/api-error.js';
import { isRecord } from '../daemon/is-record.js';
import { getDb } from './client.js';
import { newId, parseId } from './ids.js';
import { servers } from './schema.js';
import { normalizeAddress } from './address.js';
import { parseServerHost, parseServerName, type ServerEntry } from '../daemon/server-types.js';

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

const entryOf = (row: { id: string; host: string; name: string | null; addedAt: string }): ServerEntry => ({
  id: row.id,
  host: row.host,
  name: row.name,
  addedAt: row.addedAt,
});

const columns = { id: servers.id, host: servers.host, name: servers.name, addedAt: servers.addedAt };

export async function listServersForOwner(subject: string): Promise<ServerEntry[]> {
  const owner = ownerOf(subject);
  const rows = await getDb().select(columns).from(servers).where(eq(servers.owner, owner)).orderBy(asc(servers.addedAt));
  return rows.map(entryOf);
}

export async function addServerForOwner(subject: string, body: unknown): Promise<ServerEntry> {
  const owner = ownerOf(subject);
  const host = parseServerHost(isRecord(body) && typeof body.host === 'string' ? body.host : '');
  if (host === null) throw new ServerListError('host is not a server address', 400);
  const name = parseServerName(isRecord(body) ? body.name : undefined);
  const db = getDb();
  const held = await db.select(columns).from(servers).where(and(eq(servers.owner, owner), eq(servers.host, host)));
  const row = held[0];
  if (row !== undefined) {
    if (name === null) return entryOf(row);
    await db.update(servers).set({ name }).where(eq(servers.id, row.id));
    return entryOf({ ...row, name });
  }
  const next = { id: newId(), owner, host, name, addedAt: new Date().toISOString() };
  await db.insert(servers).values(next);
  return entryOf(next);
}

export async function renameServerForOwner(subject: string, rawId: string, body: unknown): Promise<ServerEntry> {
  const owner = ownerOf(subject);
  const id = idOf(rawId);
  const name = parseServerName(isRecord(body) ? body.name : undefined);
  const rows = await getDb()
    .update(servers)
    .set({ name })
    .where(and(eq(servers.id, id), eq(servers.owner, owner)))
    .returning(columns);
  const row = rows[0];
  if (row === undefined) throw missing();
  return entryOf(row);
}

export async function deleteServerForOwner(subject: string, rawId: string): Promise<{ id: string; host: string }> {
  const owner = ownerOf(subject);
  const id = idOf(rawId);
  const gone = await getDb()
    .delete(servers)
    .where(and(eq(servers.id, id), eq(servers.owner, owner)))
    .returning({ id: servers.id, host: servers.host });
  const row = gone[0];
  if (row === undefined) throw missing();
  return row;
}
