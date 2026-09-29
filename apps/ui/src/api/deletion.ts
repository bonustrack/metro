import { isRecord, str } from './read.js';
import { call } from './client.js';
import { builtInDaemon } from '../auth/daemon.js';
import { regionLabel } from '../aws/regions.js';

export interface DeletionVolume {
  volumeId: string;
  sizeGib: number;
}

export interface DeletionOwner {
  id: string;
  name: string | null;
}

export interface Deletable {
  deletable: true;
  entryOnly: boolean;
  name: string;
  node: string;
  region: string;
  instanceId: string;
  state: string;
  type: string;
  volumes: DeletionVolume[];
  owner: DeletionOwner | null;
}

export type DeletionView = { deletable: false; reason: string } | Deletable;

export type DeletionScope = 'organization' | 'admin';

const NOT_FOUND = 'not-found';
const NOT_LAUNCHED = 'not-launched';
const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const deletionUrl = (serverId: string, scope: DeletionScope): string => `${builtInDaemon()}/api/${scope === 'admin' ? 'admin/' : ''}servers/${serverId}/deletion`;

const toOwner = (body: Record<string, unknown>): DeletionOwner | null =>
  typeof body.owner === 'string' && body.owner !== '' ? { id: body.owner, name: typeof body.organizationName === 'string' ? body.organizationName : null } : null;

function toVolume(value: unknown): DeletionVolume[] {
  if (!isRecord(value) || typeof value.volumeId !== 'string' || value.volumeId === '') return [];
  return [{ volumeId: value.volumeId, sizeGib: typeof value.sizeGib === 'number' ? value.sizeGib : 0 }];
}

export function toDeletionView(body: unknown): DeletionView {
  if (!isRecord(body)) throw unexpected();
  if (body.deletable !== true) return { deletable: false, reason: str(body.reason) };
  const instanceId = str(body.instanceId);
  const state = str(body.state);
  if (instanceId === '' && state !== NOT_LAUNCHED) throw unexpected();
  return {
    deletable: true,
    entryOnly: body.entryOnly === true,
    name: str(body.name),
    node: str(body.node),
    region: str(body.region),
    instanceId,
    state,
    type: str(body.type),
    volumes: Array.isArray(body.volumes) ? body.volumes.flatMap(toVolume) : [],
    owner: toOwner(body),
  };
}

export async function fetchDeletion(serverId: string, scope: DeletionScope): Promise<DeletionView> {
  return toDeletionView(await call({ method: 'GET', base: deletionUrl(serverId, scope) }));
}

export async function deleteServer(serverId: string, view: Deletable, typed: string, scope: DeletionScope): Promise<void> {
  await call({
    method: 'POST',
    base: deletionUrl(serverId, scope),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: typed.trim(), instanceId: view.instanceId, state: view.state, volumeIds: view.volumes.map((v) => v.volumeId) }),
  });
}

const ownerLine = (owner: DeletionOwner): string => `It belongs to the organization ${owner.name === null ? owner.id : `${owner.name} (${owner.id})`}.`;

export function deletionLines(view: Deletable): string[] {
  const whose = view.owner === null ? [] : [ownerLine(view.owner)];
  const list = view.owner === null ? 'your agent list' : 'the agent list of that organization';
  if (view.state === NOT_LAUNCHED)
    return [...whose, 'Metro did not launch this server on AWS, only the agent entry will be removed.', `${view.name} leaves ${list}. The machine where it is hosted keeps running.`];
  const where = `In AWS ${regionLabel(view.region)}:`;
  const tailscale = `Its Tailscale machine ${view.node} stays in the tailnet, offline. Remove it in the Tailscale admin console.`;
  if (view.state === NOT_FOUND)
    return [...whose, 'Server not found on AWS, only the agent entry will be removed.', `AWS does not know the server ${view.instanceId} in ${view.region}. ${view.name} leaves ${list}.`, tailscale];
  if (view.state === 'terminated') return [...whose, `AWS has already deleted the server ${view.instanceId}. ${view.name} only leaves ${list}.`, tailscale];
  const server = `Server ${view.instanceId}${view.type === '' ? '' : `, ${view.type}`}, terminated.`;
  const disks = view.volumes.map((v) => `Disk ${v.volumeId}, ${String(v.sizeGib)} GB, deleted with everything on it.`);
  return [...whose, where, server, ...disks, `${view.name} leaves ${list}. This cannot be undone.`, tailscale];
}
