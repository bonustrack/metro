import { call } from './client';
import { isRecord } from './accounts';
import { fetchMode } from './mode';
import { baseFromSegment, builtInDaemon } from '../auth/daemon';

export interface Server {
  id: string;
  host: string;
  name: string | null;
  addedAt: string;
}

export type ServerStatus = { live: true; version: string | null; owner: string | null } | { live: false };

const PROBE_MS = 6_000;
const listUrl = (): string => `${builtInDaemon()}/api/servers`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

export function toServer(value: unknown): Server {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.host !== 'string') throw unexpected();
  return {
    id: value.id,
    host: value.host,
    name: typeof value.name === 'string' && value.name !== '' ? value.name : null,
    addedAt: typeof value.addedAt === 'string' ? value.addedAt : '',
  };
}

export const serverLabel = (server: Server): string => server.name ?? server.host;

export async function fetchServers(): Promise<Server[]> {
  const body = await call({ method: 'GET', base: listUrl() });
  if (!isRecord(body) || !Array.isArray(body.servers)) throw unexpected();
  return body.servers.map(toServer);
}

export async function addServer(host: string, name?: string): Promise<Server> {
  return toServer(
    await call({
      method: 'POST',
      base: listUrl(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(name === undefined ? { host } : { host, name }),
    }),
  );
}

export async function renameServer(id: string, name: string): Promise<Server> {
  return toServer(
    await call({ method: 'PUT', base: listUrl(), path: `/${id}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  );
}

export async function removeServer(id: string): Promise<void> {
  await call({ method: 'DELETE', base: listUrl(), path: `/${id}` });
}

const offline = (): ServerStatus => ({ live: false });

export function probeServer(host: string): Promise<ServerStatus> {
  const probe = fetchMode(baseFromSegment(host)).then(
    (mode): ServerStatus => ({ live: true, version: mode.version, owner: mode.owner }),
    offline,
  );
  const late = new Promise<ServerStatus>((resolve) => {
    setTimeout(() => {
      resolve(offline());
    }, PROBE_MS);
  });
  return Promise.race([probe, late]);
}
