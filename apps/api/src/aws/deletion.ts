import { AGENT_TAG, NODE_TAG } from './ec2.js';
import type { Ec2Target } from './resize.js';
import { NODE_RE } from './user-data.js';
import {
  deleteDiskWithServer,
  describeInstanceFacts,
  describeVolumeFacts,
  terminateInstance,
  type Disk,
  type InstanceFacts,
  type Tags,
  type VolumeFacts,
} from './teardown.js';

export interface DeletionAws {
  instance: (target: Ec2Target) => Promise<InstanceFacts[] | null>;
  volumes: (target: Ec2Target, volumeIds: string[]) => Promise<VolumeFacts[]>;
  deleteWithServer: (target: Ec2Target, device: string) => Promise<void>;
  terminate: (target: Ec2Target) => Promise<string[]>;
}

export const LIVE_DELETION: DeletionAws = {
  instance: (t) => describeInstanceFacts(t.credentials, t.region, t.instanceId),
  volumes: (t, ids) => describeVolumeFacts(t.credentials, t.region, ids),
  deleteWithServer: (t, device) => deleteDiskWithServer(t.credentials, t.region, t.instanceId, device),
  terminate: (t) => terminateInstance(t.credentials, t.region, t.instanceId),
};

export interface Owned {
  agentId: string;
  host: string;
}

export interface PlannedDisk {
  volumeId: string;
  sizeGib: number;
  device: string;
  deleteOnTermination: boolean;
}

export interface Plan {
  instanceId: string;
  region: string;
  node: string;
  state: string;
  type: string;
  disks: PlannedDisk[];
}

export interface Confirmed {
  instanceId: string;
  volumeIds: string[];
}

export interface Outcome {
  terminated: boolean;
  instanceId: string;
  volumeIds: string[];
}

export class DeletionRefused extends Error {}

const ENDING = ['shutting-down', 'terminated'];
const CHANGED = 'What AWS shows for this server changed since the dialog opened. Nothing was deleted. Open it again.';

const refuse = (why: string): never => {
  throw new DeletionRefused(`${why} Nothing was deleted.`);
};

export const isGone = (plan: Plan): boolean => ENDING.includes(plan.state);

function sameIds(a: string[], b: string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return new Set(x).size === x.length && x.length === y.length && x.every((id, at) => id === y[at]);
}

export function nodeOf(host: string): string {
  const node = host.split('.')[0] ?? '';
  if (!NODE_RE.test(node)) return refuse(`${host} is not an address Metro gives the servers it launches.`);
  return node;
}

function checkTags(tags: Tags, owned: Owned, node: string, what: string, nodeRequired: boolean): void {
  const tagged = tags[NODE_TAG];
  if (tagged === undefined ? nodeRequired : tagged !== node) refuse(`${what} is tagged ${NODE_TAG}=${tagged ?? '(none)'}, not ${node}.`);
  const agent = tags[AGENT_TAG];
  if (agent !== undefined && agent !== owned.agentId) refuse(`${what} is tagged for another agent, ${agent}.`);
}

function theInstance(found: InstanceFacts[] | null, target: Ec2Target): InstanceFacts {
  const { instanceId, region } = target;
  if (found === null)
    return refuse(`AWS does not know the server ${instanceId} in ${region} with Metro's key. If it was deleted in the AWS console, remove it from your list in its settings.`);
  const [only, ...more] = found;
  if (only?.instanceId !== instanceId || more.length > 0)
    return refuse(`AWS answered with ${found.map((i) => i.instanceId).join(', ') || 'no server'} when asked for ${instanceId}.`);
  return only;
}

function plannedDisk(disk: Disk, volumes: VolumeFacts[], owned: Owned, node: string, instanceId: string): PlannedDisk {
  const volume = volumes.find((v) => v.volumeId === disk.volumeId);
  if (volume === undefined) return refuse(`AWS did not describe the disk ${disk.volumeId}.`);
  if (volume.multiAttach || volume.attachedTo.length !== 1 || volume.attachedTo[0] !== instanceId)
    refuse(`The disk ${volume.volumeId} is attached to ${volume.attachedTo.join(', ') || 'no server'}, not only to ${instanceId}.`);
  checkTags(volume.tags, owned, node, `The disk ${volume.volumeId}`, false);
  return { volumeId: volume.volumeId, sizeGib: volume.sizeGib, device: disk.device, deleteOnTermination: disk.deleteOnTermination };
}

async function plannedDisks(aws: DeletionAws, target: Ec2Target, instance: InstanceFacts, owned: Owned, node: string): Promise<PlannedDisk[]> {
  const ids = instance.disks.map((d) => d.volumeId);
  if (ids.length === 0) return [];
  const volumes = await aws.volumes(target, ids);
  if (!sameIds(ids, volumes.map((v) => v.volumeId))) refuse(`AWS described the disks ${volumes.map((v) => v.volumeId).join(', ') || '(none)'} when asked for ${ids.join(', ')}.`);
  return instance.disks.map((disk) => plannedDisk(disk, volumes, owned, node, target.instanceId));
}

export async function planDeletion(aws: DeletionAws, target: Ec2Target, owned: Owned): Promise<Plan> {
  const node = nodeOf(owned.host);
  const base = { instanceId: target.instanceId, region: target.region, node };
  const instance = theInstance(await aws.instance(target), target);
  checkTags(instance.tags, owned, node, `The server ${target.instanceId}`, true);
  if (ENDING.includes(instance.state)) return { ...base, state: instance.state, type: instance.type, disks: [] };
  return { ...base, state: instance.state, type: instance.type, disks: await plannedDisks(aws, target, instance, owned, node) };
}

function checkConfirmed(plan: Plan, confirmed: Confirmed): void {
  if (confirmed.instanceId !== plan.instanceId || !sameIds(confirmed.volumeIds, plan.disks.map((d) => d.volumeId))) throw new DeletionRefused(CHANGED);
}

async function deleteDisksWithServer(aws: DeletionAws, target: Ec2Target, owned: Owned, plan: Plan, confirmed: Confirmed): Promise<void> {
  const kept = plan.disks.filter((d) => !d.deleteOnTermination);
  if (kept.length === 0) return;
  for (const disk of kept) await aws.deleteWithServer(target, disk.device);
  const again = await planDeletion(aws, target, owned);
  checkConfirmed(again, confirmed);
  const still = again.disks.filter((d) => !d.deleteOnTermination);
  if (still.length > 0) refuse(`AWS would still keep the disk ${still.map((d) => d.volumeId).join(', ')} after the server is deleted.`);
}

export async function runDeletion(aws: DeletionAws, target: Ec2Target, owned: Owned, confirmed: Confirmed): Promise<Outcome> {
  const plan = await planDeletion(aws, target, owned);
  checkConfirmed(plan, confirmed);
  const outcome = { instanceId: plan.instanceId, volumeIds: plan.disks.map((d) => d.volumeId) };
  if (isGone(plan)) return { ...outcome, terminated: false };
  await deleteDisksWithServer(aws, target, owned, plan, confirmed);
  const terminating = await aws.terminate(target);
  if (terminating.length !== 1 || terminating[0] !== target.instanceId)
    throw new Error(`AWS answered the deletion of ${target.instanceId} with ${terminating.join(', ') || 'no server'}.`);
  return { ...outcome, terminated: true };
}
