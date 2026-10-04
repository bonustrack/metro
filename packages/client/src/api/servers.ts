import { filled, isRecord } from '../read.js';
import { call } from './client.js';
import { fetchMode } from './mode.js';
import { baseFromSegment, builtInDaemon, daemonBase } from '../auth/daemon.js';
import { rememberAgents } from '../auth/agent-route.js';
import { readItem, writeItem } from '../platform.js';

export interface Server {
  id: string;
  host: string;
  name: string | null;
  addedAt: string;
  instanceId: string | null;
  launchedAt: string | null;
  avatar: string | null;
  slug: string | null;
}

type ServerState = 'live' | 'stopped' | 'offline' | 'updating';

export interface ServerStatus {
  state: ServerState;
  version: string | null;
  owner: string | null;
}

const PROBE_MS = 6_000;
const UPDATE_KEY = 'metro.update:';
const UPDATE_MS = 10 * 60_000;
const listUrl = (): string => `${builtInDaemon()}/api/servers`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');


export function toServer(value: unknown): Server {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.host !== 'string') throw unexpected();
  return {
    id: value.id,
    host: value.host,
    name: filled(value.name),
    addedAt: typeof value.addedAt === 'string' ? value.addedAt : '',
    instanceId: filled(value.instanceId),
    launchedAt: filled(value.launchedAt),
    avatar: typeof value.avatar === 'string' && value.avatar.startsWith('data:image/png;base64,') ? value.avatar : null,
    slug: filled(value.slug),
  };
}

export const serverLabel = (server: Server): string => server.name ?? server.host;

export async function fetchServers(): Promise<Server[]> {
  const body = await call({ method: 'GET', base: listUrl() });
  if (!isRecord(body) || !Array.isArray(body.servers)) throw unexpected();
  const servers = body.servers.map(toServer);
  rememberAgents(servers);
  return servers;
}

export async function addServer(host: string, name?: string): Promise<Server> {
  const server = toServer(
    await call({
      method: 'POST',
      base: listUrl(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(name === undefined ? { host } : { host, name }),
    }),
  );
  rememberAgents([server]);
  return server;
}

export async function setServerSlug(id: string, slug: string): Promise<Server> {
  const server = toServer(
    await call({ method: 'PUT', base: listUrl(), path: `/${id}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug }) }),
  );
  rememberAgents([server]);
  return server;
}

export async function renameServer(id: string, name: string): Promise<Server> {
  return toServer(
    await call({ method: 'PUT', base: listUrl(), path: `/${id}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  );
}

export async function setServerAvatar(id: string, avatar: string | null): Promise<Server> {
  return toServer(
    await call({
      method: 'PUT',
      base: listUrl(),
      path: `/${id}/avatar`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatar }),
    }),
  );
}

export async function moveServer(id: string, organization: string): Promise<Server> {
  return toServer(await call({ method: 'POST', base: `${builtInDaemon()}/api/servers/${id}/move`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organization }) }));
}

export async function moveBoxOwner(organization: string): Promise<void> {
  await call({ method: 'POST', base: `${daemonBase()}/api/owner`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: organization }) });
}

export async function removeServer(id: string): Promise<void> {
  await call({ method: 'DELETE', base: listUrl(), path: `/${id}` });
}

const offline = (): ServerStatus => ({ state: 'offline', version: null, owner: null });

export function noteUpdate(base: string, version: string, now = Date.now()): void {
  writeItem(`${UPDATE_KEY}${base}`, JSON.stringify({ version, at: now }));
}

function notedUpdate(key: string): { version: string; at: number } | null {
  try {
    const value: unknown = JSON.parse(readItem(key) ?? 'null');
    return isRecord(value) && typeof value.version === 'string' && typeof value.at === 'number' ? { version: value.version, at: value.at } : null;
  } catch {
    return null;
  }
}

export function duringUpdate(base: string, status: ServerStatus, now = Date.now()): ServerStatus {
  const key = `${UPDATE_KEY}${base}`;
  const update = notedUpdate(key);
  if (update === null) return status;
  if (status.version === update.version || now - update.at >= UPDATE_MS) {
    writeItem(key, null);
    return status;
  }
  return status.state === 'offline' ? { ...status, state: 'updating' } : status;
}

export function probeServer(host: string): Promise<ServerStatus> {
  const base = baseFromSegment(host);
  const probe = fetchMode(base).then(
    (mode): ServerStatus => ({ state: mode.stopped ? 'stopped' : 'live', version: mode.version, owner: mode.owner }),
    offline,
  );
  const late = new Promise<ServerStatus>((resolve) => {
    setTimeout(() => {
      resolve(offline());
    }, PROBE_MS);
  });
  return Promise.race([probe, late]).then((status) => duringUpdate(base, status));
}
