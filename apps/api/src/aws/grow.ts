import { NODE_TAG } from './ec2.js';
import { explain, type Ec2Target } from './resize.js';
import { growVolume, lastModification, rebootInstance, tagVolumeNode, type Modification } from './disk.js';
import { describeInstanceFacts, describeVolumeFacts, nodeIn, tagMismatch, type InstanceFacts, type VolumeFacts } from './teardown.js';

const POLL_MS = 5_000;
const WAIT_LIMIT_MS = 10 * 60_000;
const MAX_GIB: Record<string, number> = { gp2: 16_384, gp3: 65_536, io1: 16_384, io2: 65_536, st1: 16_384, sc1: 16_384, standard: 1_024 };
const OFFERED_GIB = [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048];

export interface GrowAws {
  instance: (target: Ec2Target) => Promise<InstanceFacts[]>;
  volumes: (target: Ec2Target, volumeIds: string[]) => Promise<VolumeFacts[]>;
  modification: (target: Ec2Target, volumeId: string) => Promise<Modification | null>;
  tag: (target: Ec2Target, volumeId: string, node: string) => Promise<void>;
  grow: (target: Ec2Target, volumeId: string, sizeGib: number) => Promise<Modification | null>;
  reboot: (target: Ec2Target) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const LIVE_GROW: GrowAws = {
  instance: (t) => describeInstanceFacts(t.credentials, t.region, t.instanceId),
  volumes: (t, ids) => describeVolumeFacts(t.credentials, t.region, ids),
  modification: (t, id) => lastModification(t.credentials, t.region, id),
  tag: (t, id, node) => tagVolumeNode(t.credentials, t.region, id, node),
  grow: (t, id, sizeGib) => growVolume(t.credentials, t.region, id, sizeGib),
  reboot: (t) => rebootInstance(t.credentials, t.region, t.instanceId),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  now: () => Date.now(),
};

export interface Owner {
  agentId: string;
  host: string;
}

export interface RootDisk {
  state: string;
  node: string;
  volumeId: string;
  sizeGib: number;
  type: string;
  tagged: boolean;
  modification: Modification | null;
}

export type GrowPhase = 'growing' | 'restarting' | 'done' | 'failed';

export interface GrowJob {
  from: number;
  to: number;
  restart: boolean;
  phase: GrowPhase;
  progress: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export class GrowRefused extends Error {}

const refuse = (why: string): never => {
  throw new GrowRefused(`${why} Nothing was changed.`);
};

export const maxGibOf = (type: string): number => MAX_GIB[type] ?? 0;

export const sizesFor = (disk: Pick<RootDisk, 'sizeGib' | 'type'>): number[] =>
  OFFERED_GIB.filter((gib) => gib > disk.sizeGib && gib <= maxGibOf(disk.type));

export const applying = (modification: Modification | null): boolean => modification?.state === 'modifying' || modification?.state === 'optimizing';

export const growRunning = (job: GrowJob | undefined): boolean => job !== undefined && job.phase !== 'done' && job.phase !== 'failed';

function theInstance(found: InstanceFacts[], instanceId: string): InstanceFacts {
  const [only, ...more] = found;
  if (only?.instanceId !== instanceId || more.length > 0)
    return refuse(`AWS answered with ${found.map((i) => i.instanceId).join(', ') || 'no server'} when asked for ${instanceId}.`);
  return only;
}

function theVolume(found: VolumeFacts[], volumeId: string, instanceId: string): VolumeFacts {
  const [only, ...more] = found;
  if (only?.volumeId !== volumeId || more.length > 0) return refuse(`AWS did not describe the disk ${volumeId}.`);
  if (only.multiAttach || only.attachedTo.length !== 1 || only.attachedTo[0] !== instanceId)
    refuse(`The disk ${volumeId} is attached to ${only.attachedTo.join(', ') || 'no server'}, not only to ${instanceId}.`);
  return only;
}

export async function readRootDisk(aws: GrowAws, target: Ec2Target, owner: Owner): Promise<RootDisk> {
  const { instanceId } = target;
  const node = nodeIn(owner.host) ?? refuse(`${owner.host} is not an address Metro gives the servers it launches.`);
  const instance = theInstance(await aws.instance(target), instanceId);
  const serverTags = tagMismatch(instance.tags, node, owner.agentId, true);
  if (serverTags !== null) refuse(`The server ${instanceId} ${serverTags}`);
  const root = instance.disks.find((disk) => disk.device === instance.rootDevice);
  if (root === undefined) return refuse(`AWS lists no disk at the root device of the server ${instanceId}.`);
  const volume = theVolume(await aws.volumes(target, [root.volumeId]), root.volumeId, instanceId);
  const diskTags = tagMismatch(volume.tags, node, owner.agentId, false);
  if (diskTags !== null) refuse(`The disk ${volume.volumeId} ${diskTags}`);
  return {
    state: instance.state,
    node,
    volumeId: volume.volumeId,
    sizeGib: volume.sizeGib,
    type: volume.type,
    tagged: volume.tags[NODE_TAG] !== undefined,
    modification: await aws.modification(target, volume.volumeId),
  };
}

export async function startGrow(aws: GrowAws, target: Ec2Target, disk: RootDisk, sizeGib: number): Promise<GrowJob> {
  if (!disk.tagged) await aws.tag(target, disk.volumeId, disk.node);
  const started = await aws.grow(target, disk.volumeId, sizeGib);
  return {
    from: disk.sizeGib,
    to: sizeGib,
    restart: disk.state === 'running',
    phase: 'growing',
    progress: started?.progress ?? 0,
    error: null,
    startedAt: new Date(aws.now()).toISOString(),
    finishedAt: null,
  };
}

function finish(aws: GrowAws, job: GrowJob, error: string | null): void {
  job.phase = error === null ? 'done' : 'failed';
  job.error = error;
  job.finishedAt = new Date(aws.now()).toISOString();
}

async function waitForSpace(aws: GrowAws, target: Ec2Target, volumeId: string, job: GrowJob): Promise<string | null> {
  const began = aws.now();
  for (;;) {
    const seen = await aws.modification(target, volumeId).catch(() => null);
    if (seen?.targetGib === job.to) {
      job.progress = seen.progress;
      if (seen.state === 'optimizing' || seen.state === 'completed') return null;
      if (seen.state === 'failed') return `AWS could not grow the disk${seen.message === '' ? '.' : `: ${seen.message}`} It stays at ${String(job.from)} GiB.`;
    }
    if (aws.now() - began >= WAIT_LIMIT_MS)
      return `AWS has not grown the disk to ${String(job.to)} GiB within ${String(WAIT_LIMIT_MS / 60_000)} minutes. If it still does, the server uses the space after its next restart.`;
    await aws.sleep(POLL_MS);
  }
}

export async function runGrow(aws: GrowAws, target: Ec2Target, volumeId: string, job: GrowJob): Promise<void> {
  const failure = await waitForSpace(aws, target, volumeId, job);
  if (failure !== null || !job.restart) {
    finish(aws, job, failure);
    return;
  }
  job.phase = 'restarting';
  try {
    await aws.reboot(target);
    finish(aws, job, null);
  } catch (err) {
    finish(aws, job, `The disk is now ${String(job.to)} GiB, but AWS did not restart the server: ${explain(err, '')} It uses the space after its next restart.`);
  }
}
