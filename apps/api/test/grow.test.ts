import { describe, expect, test } from 'bun:test';
import { AwsError } from '../src/aws/ec2.ts';
import { GrowRefused, growRunning, readRootDisk, runGrow, sizesFor, startGrow, type GrowJob } from '../src/aws/grow.ts';
import { BOX, BOX_DISK, HOST, instance, OTHER, volume } from './deletion-fake.ts';
import { fakeDisks, fakeGrowAws, modification, type FakeDisks } from './grow-fake.ts';

const TARGET = { credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' }, region: 'us-east-1', instanceId: BOX };
const OWNER = { agentId: 'srv00000001', host: HOST };

const refusal = async (disks: FakeDisks, owner = OWNER): Promise<string> => {
  const err = await readRootDisk(fakeGrowAws(disks), TARGET, owner).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GrowRefused);
  return (err as GrowRefused).message;
};

async function grown(disks: FakeDisks, sizeGib: number): Promise<GrowJob> {
  const aws = fakeGrowAws(disks);
  const disk = await readRootDisk(aws, TARGET, OWNER);
  const job = await startGrow(aws, TARGET, disk, sizeGib);
  await runGrow(aws, TARGET, disk.volumeId, job);
  return job;
}

const writes = (disks: FakeDisks): string[] => disks.calls.filter((c) => !c.startsWith('Describe'));

describe('the root disk of a box', () => {
  test('is read from the instance root device, with its size, type and last change', async () => {
    const disks = fakeDisks({ modification: modification(), next: [] });
    expect(await readRootDisk(fakeGrowAws(disks), TARGET, OWNER)).toEqual({
      state: 'running',
      node: 'metro-thrw01',
      volumeId: BOX_DISK,
      sizeGib: 8,
      type: 'gp3',
      tagged: true,
      modification: modification(),
    });
    expect(disks.calls).toEqual([`DescribeInstances ${BOX}`, `DescribeVolumes ${BOX_DISK}`, `DescribeVolumesModifications ${BOX_DISK}`]);
  });

  test('a disk launched before volumes were tagged is accepted and marked untagged', async () => {
    const disks = fakeDisks({ volumes: [volume({ tags: {} })] });
    expect((await readRootDisk(fakeGrowAws(disks), TARGET, OWNER)).tagged).toBe(false);
  });

  test('refuses a box whose tags, address or disks do not match, before any change', async () => {
    expect(await refusal(fakeDisks({ instances: [instance({ tags: { metro: 'metro-other1' } })] }))).toBe(
      `The server ${BOX} is tagged metro=metro-other1, not metro-thrw01. Nothing was changed.`,
    );
    expect(await refusal(fakeDisks({ instances: [instance({ tags: { metro: 'metro-thrw01', 'metro:agent': 'srv00000009' } })] }))).toContain('another agent');
    expect(await refusal(fakeDisks({ volumes: [volume({ tags: { metro: 'metro-other1' } })] }))).toContain(`The disk ${BOX_DISK} is tagged metro=metro-other1`);
    expect(await refusal(fakeDisks({ volumes: [volume({ attachedTo: [BOX, OTHER], multiAttach: true })] }))).toContain('not only to');
    expect(await refusal(fakeDisks({ volumes: [] }))).toContain(`AWS did not describe the disk ${BOX_DISK}`);
    expect(await refusal(fakeDisks({ instances: [instance({ rootDevice: '/dev/xvda' })] }))).toContain('no disk at the root device');
    expect(await refusal(fakeDisks({ instances: [] }))).toContain('no server');
    expect(await refusal(fakeDisks(), { ...OWNER, host: 'box.example.com' })).toContain('is not an address Metro gives');
  });
});

describe('the sizes offered', () => {
  test('are only bigger than now and within what AWS allows for the type', () => {
    expect(sizesFor({ sizeGib: 20, type: 'gp3' })).toEqual([24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048]);
    expect(sizesFor({ sizeGib: 512, type: 'standard' })).toEqual([768, 1024]);
    expect(sizesFor({ sizeGib: 2048, type: 'gp3' })).toEqual([]);
    expect(sizesFor({ sizeGib: 8, type: 'magnetic-ish' })).toEqual([]);
  });
});

describe('growing the disk', () => {
  test('a running box: ModifyVolume, wait until AWS optimizes, then restart it once', async () => {
    const disks = fakeDisks({ next: ['modifying', 'optimizing'] });
    const job = await grown(disks, 32);
    expect(writes(disks)).toEqual([`ModifyVolume ${BOX_DISK} 32`, `RebootInstances ${BOX}`]);
    expect(job).toMatchObject({ from: 8, to: 32, restart: true, phase: 'done', error: null });
    expect(growRunning(job)).toBe(false);
  });

  test('an untagged disk gets the box node tag first, so the IAM condition holds', async () => {
    const disks = fakeDisks({ volumes: [volume({ tags: {} })] });
    await grown(disks, 16);
    expect(writes(disks)).toEqual([`CreateTags ${BOX_DISK} metro=metro-thrw01`, `ModifyVolume ${BOX_DISK} 16`, `RebootInstances ${BOX}`]);
  });

  test('a stopped box is not restarted: it uses the space when it starts', async () => {
    const disks = fakeDisks({ instances: [instance({ state: 'stopped' })], next: ['completed'] });
    const job = await grown(disks, 16);
    expect(writes(disks)).toEqual([`ModifyVolume ${BOX_DISK} 16`]);
    expect(job).toMatchObject({ restart: false, phase: 'done' });
  });

  test('AWS failing the change says so and restarts nothing', async () => {
    const disks = fakeDisks({ next: ['failed'] });
    const job = await grown(disks, 16);
    expect(writes(disks)).toEqual([`ModifyVolume ${BOX_DISK} 16`]);
    expect(job).toMatchObject({ phase: 'failed', error: 'AWS could not grow the disk. It stays at 8 GiB.' });
  });

  test('AWS never getting there ends the job after 10 minutes, without a restart', async () => {
    const disks = fakeDisks({ next: [] });
    const job = await grown(disks, 16);
    expect(writes(disks)).toEqual([`ModifyVolume ${BOX_DISK} 16`]);
    expect(job.phase).toBe('failed');
    expect(job.error).toContain('within 10 minutes');
  });

  test('a refused restart keeps the bigger disk and says it is used at the next restart', async () => {
    const disks = fakeDisks({ refuse: { reboot: new AwsError('UnauthorizedOperation', 'no', 'ec2:RebootInstances') } });
    const job = await grown(disks, 16);
    expect(job.phase).toBe('failed');
    expect(job.error).toBe(
      "The disk is now 16 GiB, but AWS did not restart the server: Metro may not call ec2:RebootInstances in this AWS account. Add it to the policy Metro uses there. It uses the space after its next restart.",
    );
  });

  test('a just tagged disk waits for the tag to reach IAM before ModifyVolume gives up', async () => {
    const disks = fakeDisks({ volumes: [volume({ tags: {} })] });
    const aws = fakeGrowAws(disks);
    const grow = aws.grow;
    let denials = 2;
    aws.grow = (target, volumeId, sizeGib) => {
      if (denials === 0) return grow(target, volumeId, sizeGib);
      denials -= 1;
      disks.calls.push('ModifyVolume denied');
      return Promise.reject(new AwsError('UnauthorizedOperation', 'not yet', 'ec2:ModifyVolume'));
    };
    const began = disks.clock;
    const disk = await readRootDisk(aws, TARGET, OWNER);
    const job = await startGrow(aws, TARGET, disk, 16);
    expect(writes(disks)).toEqual([`CreateTags ${BOX_DISK} metro=metro-thrw01`, 'ModifyVolume denied', 'ModifyVolume denied', `ModifyVolume ${BOX_DISK} 16`]);
    expect(disks.clock - began).toBe(6_000);
    expect(job.phase).toBe('growing');
    denials = 9;
    const again = await startGrow(aws, TARGET, { ...disk, tagged: false }, 16).catch((e: unknown) => e);
    expect(again).toMatchObject({ code: 'UnauthorizedOperation' });
  });

  test('a tagged disk is not retried: a refusal there is the policy', async () => {
    const disks = fakeDisks({ refuse: { grow: new AwsError('UnauthorizedOperation', 'no', 'ec2:ModifyVolume') } });
    const aws = fakeGrowAws(disks);
    const disk = await readRootDisk(aws, TARGET, OWNER);
    await expect(startGrow(aws, TARGET, disk, 16)).rejects.toBeInstanceOf(AwsError);
    expect(writes(disks)).toEqual([`ModifyVolume ${BOX_DISK} 16`]);
  });

  test('a refused ModifyVolume throws before any job exists', async () => {
    const disks = fakeDisks({ refuse: { grow: new AwsError('UnauthorizedOperation', 'no', 'ec2:ModifyVolume') } });
    const aws = fakeGrowAws(disks);
    const disk = await readRootDisk(aws, TARGET, OWNER);
    await expect(startGrow(aws, TARGET, disk, 16)).rejects.toBeInstanceOf(AwsError);
  });
});
