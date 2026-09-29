import { isRecord, str } from './read.js';
import { call } from './client.js';
import { builtInDaemon } from '../auth/daemon.js';
import { regionLabel } from '../aws/regions.js';

export interface DeletionVolume {
  volumeId: string;
  sizeGib: number;
}

export interface Deletable {
  deletable: true;
  name: string;
  node: string;
  region: string;
  instanceId: string;
  state: string;
  type: string;
  volumes: DeletionVolume[];
}

export type DeletionView = { deletable: false; reason: string } | Deletable;

const ENDED = ['shutting-down', 'terminated'];
const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const deletionUrl = (serverId: string): string => `${builtInDaemon()}/api/servers/${serverId}/deletion`;

function toVolume(value: unknown): DeletionVolume[] {
  if (!isRecord(value) || typeof value.volumeId !== 'string' || value.volumeId === '') return [];
  return [{ volumeId: value.volumeId, sizeGib: typeof value.sizeGib === 'number' ? value.sizeGib : 0 }];
}

export function toDeletionView(body: unknown): DeletionView {
  if (!isRecord(body)) throw unexpected();
  if (body.deletable !== true) return { deletable: false, reason: str(body.reason) };
  const instanceId = str(body.instanceId);
  if (instanceId === '') throw unexpected();
  return {
    deletable: true,
    name: str(body.name),
    node: str(body.node),
    region: str(body.region),
    instanceId,
    state: str(body.state),
    type: str(body.type),
    volumes: Array.isArray(body.volumes) ? body.volumes.flatMap(toVolume) : [],
  };
}

export async function fetchDeletion(serverId: string): Promise<DeletionView> {
  return toDeletionView(await call({ method: 'GET', base: deletionUrl(serverId) }));
}

export async function deleteServer(serverId: string, view: Deletable, typed: string): Promise<void> {
  await call({
    method: 'POST',
    base: deletionUrl(serverId),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: typed.trim(), instanceId: view.instanceId, volumeIds: view.volumes.map((v) => v.volumeId) }),
  });
}

export function deletionLines(view: Deletable): string[] {
  const where = `In AWS ${regionLabel(view.region)}:`;
  const tailscale = `Its Tailscale machine ${view.node} stays in the tailnet, offline. Remove it in the Tailscale admin console.`;
  if (ENDED.includes(view.state))
    return [`AWS has already deleted the server ${view.instanceId}. ${view.name} only leaves your agent list.`, tailscale];
  const server = `Server ${view.instanceId}${view.type === '' ? '' : `, ${view.type}`}, terminated.`;
  const disks = view.volumes.map((v) => `Disk ${v.volumeId}, ${String(v.sizeGib)} GB, deleted with everything on it.`);
  return [where, server, ...disks, `${view.name} leaves your agent list. This cannot be undone.`, tailscale];
}
