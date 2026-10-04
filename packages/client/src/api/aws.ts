import { filled, isRecord, str } from '../read.js';
import { call } from './client.js';
import { builtInDaemon } from '../auth/daemon.js';

export interface AwsConnection {
  id: string;
  accountId: string;
  roleArn: string;
  addedAt: string;
}

export interface AwsOverview {
  ready: boolean;
  reason: string | null;
  metroRole: string | null;
  externalId: string | null;
  connections: AwsConnection[];
}

export interface AwsLinkStart {
  url: string;
  externalId: string;
}

export interface FoundInstance {
  connection: string;
  accountId: string;
  region: string;
  instanceId: string;
  name: string | null;
  state: string;
  type: string;
  node: string | null;
  agentId: string | null;
}

export interface FoundInstances {
  instances: FoundInstance[];
  errors: { accountId: string; error: string }[];
}

export type ServerLink =
  | { mode: 'metro' }
  | { mode: 'none'; connections: number }
  | { mode: 'linked'; connection: string; accountId: string | null; region: string; instanceId: string };

const awsUrl = (): string => `${builtInDaemon()}/api/aws`;
const linkUrl = (serverId: string): string => `${builtInDaemon()}/api/servers/${serverId}/link`;
const JSON_HEADERS = { 'content-type': 'application/json' };
const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const toConnection = (value: Record<string, unknown>): AwsConnection => ({ id: str(value.id), accountId: str(value.accountId), roleArn: str(value.roleArn), addedAt: str(value.addedAt) });

export async function fetchAws(): Promise<AwsOverview> {
  const body = await call({ method: 'GET', base: awsUrl() });
  if (!isRecord(body)) throw unexpected();
  return {
    ready: body.ready === true,
    reason: filled(body.reason),
    metroRole: filled(body.metroRole),
    externalId: filled(body.externalId),
    connections: records(body.connections).map(toConnection),
  };
}

export async function startAwsLink(): Promise<AwsLinkStart> {
  const body = await call({ method: 'POST', base: awsUrl(), path: '/link' });
  if (!isRecord(body) || typeof body.url !== 'string') throw unexpected();
  return { url: body.url, externalId: str(body.externalId) };
}

export async function connectAws(roleArn: string): Promise<void> {
  await call({ method: 'POST', base: awsUrl(), path: '/connections', headers: JSON_HEADERS, body: JSON.stringify({ roleArn }) });
}

export async function disconnectAws(id: string): Promise<void> {
  await call({ method: 'DELETE', base: awsUrl(), path: `/connections/${id}` });
}

const toInstance = (v: Record<string, unknown>): FoundInstance => ({
  connection: str(v.connection),
  accountId: str(v.accountId),
  region: str(v.region),
  instanceId: str(v.instanceId),
  name: filled(v.name),
  state: str(v.state),
  type: str(v.type),
  node: filled(v.node),
  agentId: filled(v.agentId),
});

export async function fetchInstances(): Promise<FoundInstances> {
  const body = await call({ method: 'GET', base: awsUrl(), path: '/instances' });
  if (!isRecord(body)) throw unexpected();
  return {
    instances: records(body.instances).map(toInstance),
    errors: records(body.errors).map((e) => ({ accountId: str(e.accountId), error: str(e.error) })),
  };
}

export function toServerLink(body: unknown): ServerLink {
  if (!isRecord(body)) throw unexpected();
  if (body.mode === 'metro') return { mode: 'metro' };
  if (body.mode === 'linked') return { mode: 'linked', connection: str(body.connection), accountId: filled(body.accountId), region: str(body.region), instanceId: str(body.instanceId) };
  return { mode: 'none', connections: typeof body.connections === 'number' ? body.connections : 0 };
}

export const fetchServerLink = async (serverId: string): Promise<ServerLink> => toServerLink(await call({ method: 'GET', base: linkUrl(serverId) }));

export const linkServer = async (serverId: string, found: Pick<FoundInstance, 'connection' | 'region' | 'instanceId'>): Promise<ServerLink> =>
  toServerLink(await call({ method: 'POST', base: linkUrl(serverId), headers: JSON_HEADERS, body: JSON.stringify({ connection: found.connection, region: found.region, instanceId: found.instanceId }) }));

export const unlinkServer = async (serverId: string): Promise<ServerLink> =>
  toServerLink(await call({ method: 'POST', base: linkUrl(serverId), headers: JSON_HEADERS, body: JSON.stringify({ unlink: true }) }));

export const instanceLabel = (i: FoundInstance): string => [i.name ?? i.instanceId, i.name === null ? '' : i.instanceId, i.region, i.state].filter((part) => part !== '').join(' · ');
