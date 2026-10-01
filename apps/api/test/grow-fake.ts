import type { AwsError } from '../src/aws/ec2.ts';
import type { Modification, ModificationState } from '../src/aws/disk.ts';
import type { GrowAws } from '../src/aws/grow.ts';
import type { InstanceFacts, VolumeFacts } from '../src/aws/teardown.ts';
import { instance, otherDisk, otherServer, volume } from './deletion-fake.ts';

export interface FakeDisks {
  instances: InstanceFacts[];
  volumes: VolumeFacts[];
  modification: Modification | null;
  next: ModificationState[];
  calls: string[];
  refuse: Partial<Record<'grow' | 'reboot' | 'tag', AwsError>>;
  hold: Promise<void> | null;
  clock: number;
}

export const fakeDisks = (over: Partial<FakeDisks> = {}): FakeDisks => ({
  instances: [instance(), otherServer()],
  volumes: [volume(), otherDisk()],
  modification: null,
  next: ['optimizing'],
  calls: [],
  refuse: {},
  hold: null,
  clock: 1_800_000_000_000,
  ...over,
});

export const modification = (over: Partial<Modification> = {}): Modification => ({
  state: 'completed',
  progress: 100,
  originalGib: 8,
  targetGib: 16,
  startedAt: '2026-10-01T00:00:00.000Z',
  message: '',
  ...over,
});

const copy = <T>(value: T): T => structuredClone(value);

export function fakeGrowAws(disks: FakeDisks): GrowAws {
  const refused = (verb: 'grow' | 'reboot' | 'tag'): Promise<never> | null => {
    const err = disks.refuse[verb];
    return err === undefined ? null : Promise.reject(err);
  };
  return {
    instance: (target) => {
      disks.calls.push(`DescribeInstances ${target.instanceId}`);
      return Promise.resolve(copy(disks.instances.filter((i) => i.instanceId === target.instanceId)));
    },
    volumes: (_target, ids) => {
      disks.calls.push(`DescribeVolumes ${ids.join(',')}`);
      return Promise.resolve(copy(disks.volumes.filter((v) => ids.includes(v.volumeId))));
    },
    modification: (_target, volumeId) => {
      disks.calls.push(`DescribeVolumesModifications ${volumeId}`);
      const state = disks.modification === null ? undefined : disks.next.shift();
      if (disks.modification !== null && state !== undefined) disks.modification.state = state;
      return Promise.resolve(copy(disks.modification));
    },
    tag: (_target, volumeId, node) => {
      disks.calls.push(`CreateTags ${volumeId} metro=${node}`);
      const found = disks.volumes.find((v) => v.volumeId === volumeId);
      if (found !== undefined) found.tags.metro = node;
      return refused('tag') ?? Promise.resolve();
    },
    grow: (_target, volumeId, sizeGib) => {
      disks.calls.push(`ModifyVolume ${volumeId} ${String(sizeGib)}`);
      const refusal = refused('grow');
      if (refusal !== null) return refusal;
      const found = disks.volumes.find((v) => v.volumeId === volumeId);
      disks.modification = modification({ state: 'modifying', progress: 0, originalGib: found?.sizeGib ?? 0, targetGib: sizeGib });
      if (found !== undefined) found.sizeGib = sizeGib;
      return Promise.resolve(copy(disks.modification));
    },
    reboot: async (target) => {
      disks.calls.push(`RebootInstances ${target.instanceId}`);
      if (disks.hold !== null) await disks.hold;
      const refusal = refused('reboot');
      if (refusal !== null) await refusal;
    },
    sleep: (ms) => {
      disks.clock += ms;
      return Promise.resolve();
    },
    now: () => disks.clock,
  };
}
