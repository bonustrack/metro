import { AwsError } from '../src/aws/ec2.ts';
import type { DeletionAws } from '../src/aws/deletion.ts';
import type { InstanceFacts, VolumeFacts } from '../src/aws/teardown.ts';

export interface FakeAccount {
  instances: InstanceFacts[];
  volumes: VolumeFacts[];
  calls: string[];
  keepDisks: boolean;
  answerFor: string | null;
  refuse: AwsError | null;
  describeFails: Error | null;
}

export const BOX = 'i-0b0c0000000000001';
export const BOX_DISK = 'vol-0b0c0000000000001';
export const OTHER = 'i-0a0a0000000000002';
export const OTHER_DISK = 'vol-0a0a0000000000002';
export const NODE = 'metro-thrw01';
export const HOST = `${NODE}.tail17c4f8.ts.net`;

export const instance = (over: Partial<InstanceFacts> = {}): InstanceFacts => ({
  instanceId: BOX,
  state: 'running',
  type: 't4g.medium',
  tags: { Name: 'metro:throwaway', metro: NODE, 'metro:agent': 'srv00000001' },
  disks: [{ device: '/dev/sda1', volumeId: BOX_DISK, deleteOnTermination: true }],
  profile: null,
  ...over,
});

export const volume = (over: Partial<VolumeFacts> = {}): VolumeFacts => ({
  volumeId: BOX_DISK,
  sizeGib: 8,
  state: 'in-use',
  tags: { Name: 'metro:throwaway', metro: NODE, 'metro:agent': 'srv00000001' },
  attachedTo: [BOX],
  multiAttach: false,
  ...over,
});

export const otherServer = (): InstanceFacts =>
  instance({
    instanceId: OTHER,
    tags: { Name: 'metro:lisa', metro: 'metro-fa79qt' },
    disks: [{ device: '/dev/sda1', volumeId: OTHER_DISK, deleteOnTermination: true }],
  });

export const otherDisk = (): VolumeFacts => volume({ volumeId: OTHER_DISK, sizeGib: 32, tags: {}, attachedTo: [OTHER] });

export const fakeAccount = (over: Partial<FakeAccount> = {}): FakeAccount => ({
  instances: [instance(), otherServer()],
  volumes: [volume(), otherDisk()],
  calls: [],
  keepDisks: false,
  answerFor: null,
  refuse: null,
  describeFails: null,
  ...over,
});

const copy = <T>(value: T): T => structuredClone(value);

export function fakeDeletionAws(account: FakeAccount): DeletionAws {
  const refused = (): Promise<never> | null => (account.refuse === null ? null : Promise.reject(account.refuse));
  return {
    instance: (target) => {
      account.calls.push(`DescribeInstances ${target.region} ${target.instanceId}`);
      if (account.describeFails !== null) return Promise.reject(account.describeFails);
      const asked = account.answerFor ?? target.instanceId;
      const found = account.instances.filter((i) => i.instanceId === asked);
      if (found.length === 0) return Promise.reject(new AwsError('InvalidInstanceID.NotFound', `The instance ID '${asked}' does not exist`, 'ec2:DescribeInstances'));
      return Promise.resolve(copy(found));
    },
    volumes: (target, ids) => {
      account.calls.push(`DescribeVolumes ${target.region} ${ids.join(',')}`);
      return refused() ?? Promise.resolve(copy(account.volumes.filter((v) => ids.includes(v.volumeId))));
    },
    deleteWithServer: (target, device) => {
      account.calls.push(`ModifyInstanceAttribute ${target.instanceId} ${device} DeleteOnTermination=true`);
      if (!account.keepDisks)
        for (const i of account.instances.filter((x) => x.instanceId === target.instanceId))
          for (const disk of i.disks.filter((d) => d.device === device)) disk.deleteOnTermination = true;
      return Promise.resolve();
    },
    terminate: (target) => {
      account.calls.push(`TerminateInstances ${target.region} ${target.instanceId}`);
      const hit = account.instances.find((i) => i.instanceId === target.instanceId);
      if (hit === undefined) return Promise.reject(new AwsError('InvalidInstanceID.NotFound', 'not found', 'ec2:TerminateInstances'));
      hit.state = 'shutting-down';
      account.volumes = account.volumes.filter((v) => !hit.disks.some((d) => d.deleteOnTermination && d.volumeId === v.volumeId));
      return Promise.resolve([hit.instanceId]);
    },
  };
}
