import { and, asc, desc, eq } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { getDb } from './client.js';
import { isUniqueViolation } from './errors.js';
import { newId, parseId } from '@metro-labs/core/ids';
import { agents } from './schema.js';
import { parseServerHost, parseServerName, type ServerEntry } from '../server-types.js';
import { parseAvatar } from '../avatar.js';
import { parseSlug, slugify, withSuffix } from '../slug.js';
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
  slug: string | null;
}

const entryOf = (row: Row): ServerEntry => ({
  id: row.id,
  host: row.host,
  name: row.name,
  addedAt: row.addedAt,
  instanceId: row.instanceId,
  launchedAt: row.launchedAt,
  avatar: row.avatar,
  slug: row.slug,
});

const columns = {
  id: agents.id,
  host: agents.host,
  name: agents.name,
  addedAt: agents.addedAt,
  instanceId: agents.instanceId,
  launchedAt: agents.launchedAt,
  avatar: agents.avatar,
  slug: agents.slug,
};

const SLUG_TRIES = 50;
const slugTaken = (): ServerListError => new ServerListError('another agent in this organization already has that slug', 409);

async function freeSlug(owner: string, base: string): Promise<string> {
  const rows = await getDb().select({ slug: agents.slug }).from(agents).where(eq(agents.owner, owner));
  const taken = new Set(rows.map((r) => r.slug));
  const first = slugify(base);
  for (let n = 1; n <= SLUG_TRIES; n += 1) {
    const candidate = n === 1 ? first : withSuffix(first, n);
    if (!taken.has(candidate)) return candidate;
  }
  throw slugTaken();
}

async function withSlug(owner: string, row: Row): Promise<Row> {
  if (row.slug !== null) return row;
  const slug = await freeSlug(owner, row.name ?? row.host);
  try {
    await getDb().update(agents).set({ slug }).where(and(eq(agents.id, row.id), eq(agents.owner, owner)));
  } catch (err) {
    if (isUniqueViolation(err)) return row;
    throw err;
  }
  return { ...row, slug };
}

const INSERT_TRIES = 3;

async function insertAgent<T extends typeof agents.$inferInsert & { slug: string }>(owner: string, first: T, base: string): Promise<T> {
  let next = first;
  for (let attempt = 1; attempt <= INSERT_TRIES; attempt += 1) {
    try {
      await getDb().insert(agents).values(next);
      return next;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      next = { ...next, slug: await freeSlug(owner, base) };
    }
  }
  throw new ServerListError('that organization already lists an agent with this address or slug', 409);
}

export interface AgentSummary {
  id: string;
  owner: string;
  host: string;
  name: string | null;
  slug: string | null;
  addedAt: string;
  avatar: string | null;
}

export async function listAllServers(): Promise<AgentSummary[]> {
  const rows = await getDb()
    .select({ id: agents.id, owner: agents.owner, host: agents.host, name: agents.name, slug: agents.slug, addedAt: agents.addedAt, avatar: agents.avatar })
    .from(agents)
    .orderBy(desc(agents.addedAt));
  return rows.map((r) => ({ ...r, avatar: r.avatar?.startsWith('data:image/png;base64,') === true ? r.avatar : null }));
}

export async function listServersForOwner(subject: string): Promise<ServerEntry[]> {
  const owner = ownerOf(subject);
  const rows = await getDb().select(columns).from(agents).where(eq(agents.owner, owner)).orderBy(asc(agents.addedAt));
  const filled: Row[] = [];
  for (const row of rows) filled.push(await withSlug(owner, row));
  return filled.map(entryOf);
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
  const next = { id: newId(), owner, host, name, addedAt: new Date().toISOString(), instanceId: null, launchedAt: null, avatar: null, slug: await freeSlug(owner, name ?? host) };
  return entryOf(await insertAgent(owner, next, name ?? host));
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
    slug: await freeSlug(owner, launch.name),
  };
  return entryOf(await insertAgent(owner, next, launch.name));
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

function renameChanges(body: unknown): { name?: string | null; slug?: string } {
  const hasName = isRecord(body) && 'name' in body;
  const slug = isRecord(body) && typeof body.slug === 'string' ? parseSlug(body.slug) : undefined;
  if (!hasName && slug === undefined) throw new ServerListError('send a name or a slug', 400);
  return { ...(hasName ? { name: parseServerName(body.name) } : {}), ...(slug === undefined ? {} : { slug }) };
}

export async function renameServerForOwner(subject: string, rawId: string, body: unknown): Promise<ServerEntry> {
  const owner = ownerOf(subject);
  const id = idOf(rawId);
  const changes = renameChanges(body);
  try {
    const rows = await getDb()
      .update(agents)
      .set(changes)
      .where(and(eq(agents.id, id), eq(agents.owner, owner)))
      .returning(columns);
    const row = rows[0];
    if (row === undefined) throw missing();
    return entryOf(await withSlug(owner, row));
  } catch (err) {
    if (isUniqueViolation(err)) throw slugTaken();
    throw err;
  }
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
    if (isUniqueViolation(err)) throw new ServerListError('that organization already lists an agent with this address or slug', 409);
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
