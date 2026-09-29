import { describe, expect, test } from 'bun:test';
import { DeletionRefused, nodeOf, planDeletion, runDeletion, type Owned } from '../src/aws/deletion.ts';
import { AwsError } from '../src/aws/ec2.ts';
import { BOX, BOX_DISK, HOST, NODE, OTHER, OTHER_DISK, fakeAccount, fakeDeletionAws, instance, otherServer, volume, type FakeAccount } from './deletion-fake.ts';

const TARGET = { credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' }, region: 'us-east-1', instanceId: BOX };
const OWNED: Owned = { agentId: 'srv00000001', host: HOST, addedAt: '2026-09-01T10:00:00.000Z' };
const CONFIRMED = { instanceId: BOX, state: 'running', volumeIds: [BOX_DISK] };
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

const run = (account: FakeAccount, confirmed = CONFIRMED, owned = OWNED): Promise<unknown> => runDeletion(fakeDeletionAws(account), TARGET, owned, confirmed);

const writes = (account: FakeAccount): string[] => account.calls.filter((c) => !c.startsWith('Describe'));

async function refused(account: FakeAccount, message: string, confirmed = CONFIRMED, owned = OWNED): Promise<void> {
  const err = await run(account, confirmed, owned).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DeletionRefused);
  expect((err as Error).message).toContain(message);
  expect(writes(account)).toEqual([]);
  expect(account.instances.map((i) => i.state)).toEqual(['running', 'running']);
}

describe('what a deletion would remove', () => {
  test('lists exactly the stored instance and the disk attached to it, with its size', async () => {
    const account = fakeAccount();
    const plan = await planDeletion(fakeDeletionAws(account), TARGET, OWNED);
    expect(plan).toEqual({
      instanceId: BOX,
      region: 'us-east-1',
      node: NODE,
      state: 'running',
      type: 't4g.medium',
      disks: [{ volumeId: BOX_DISK, sizeGib: 8, device: '/dev/sda1', deleteOnTermination: true }],
    });
    expect(account.calls).toEqual([`DescribeInstances us-east-1 ${BOX}`, `DescribeVolumes us-east-1 ${BOX_DISK}`]);
  });

  test('an address Metro never gives a server is refused before AWS is asked', async () => {
    const account = fakeAccount();
    await refused(account, 'is not an address Metro gives', CONFIRMED, { ...OWNED, host: 'tony.example.com' });
    expect(account.calls).toEqual([]);
    expect(nodeOf('metro-abc123.tail17c4f8.ts.net')).toBe('metro-abc123');
  });
});

describe('a deletion', () => {
  test('terminates only the stored instance id, and deletes no disk by any call of its own', async () => {
    const account = fakeAccount();
    expect(await run(account)).toEqual({ terminated: true, instanceId: BOX, volumeIds: [BOX_DISK] });
    expect(account.calls).toEqual([`DescribeInstances us-east-1 ${BOX}`, `DescribeVolumes us-east-1 ${BOX_DISK}`, `TerminateInstances us-east-1 ${BOX}`]);
    expect(account.instances.find((i) => i.instanceId === OTHER)?.state).toBe('running');
    expect(account.volumes.map((v) => v.volumeId)).toEqual([OTHER_DISK]);
  });

  test('a box launched before the agent tag existed is matched by its node tag alone', async () => {
    const account = fakeAccount({
      instances: [instance({ tags: { Name: 'metro:old', metro: NODE } }), otherServer()],
      volumes: [volume({ tags: {} })],
    });
    expect(await run(account)).toMatchObject({ terminated: true });
    expect(writes(account)).toEqual([`TerminateInstances us-east-1 ${BOX}`]);
  });

  test('a disk AWS would keep is set to go with the server on its own device, checked again, then the server goes', async () => {
    const account = fakeAccount({
      instances: [instance({ disks: [{ device: '/dev/sda1', volumeId: BOX_DISK, deleteOnTermination: false }] }), otherServer()],
    });
    expect(await run(account)).toMatchObject({ terminated: true, volumeIds: [BOX_DISK] });
    expect(writes(account)).toEqual([`ModifyInstanceAttribute ${BOX} /dev/sda1 DeleteOnTermination=true`, `TerminateInstances us-east-1 ${BOX}`]);
  });

  test('when AWS still keeps the disk after that, nothing is terminated', async () => {
    const account = fakeAccount({
      keepDisks: true,
      instances: [instance({ disks: [{ device: '/dev/sda1', volumeId: BOX_DISK, deleteOnTermination: false }] }), otherServer()],
    });
    const err = await run(account).catch((e: unknown) => e);
    expect((err as Error).message).toContain(`would still keep the disk ${BOX_DISK}`);
    expect(writes(account)).toEqual([`ModifyInstanceAttribute ${BOX} /dev/sda1 DeleteOnTermination=true`]);
  });

  test('a server AWS reports terminated is not asked to terminate again, even one launched a minute ago', async () => {
    const ended = fakeAccount({ instances: [instance({ state: 'terminated', disks: [] }), otherServer()] });
    expect(await run(ended, { instanceId: BOX, state: 'terminated', volumeIds: [] })).toEqual({ terminated: false, instanceId: BOX, volumeIds: [] });
    const young = fakeAccount({ instances: [instance({ state: 'terminated', disks: [] }), otherServer()] });
    expect(await run(young, { instanceId: BOX, state: 'terminated', volumeIds: [] }, { ...OWNED, addedAt: ago(1) })).toMatchObject({ terminated: false });
    expect([...writes(ended), ...writes(young)]).toEqual([]);
  });

  test('a server AWS does not know, on a row older than 10 minutes, is not on AWS: nothing is written there', async () => {
    const account = fakeAccount({ instances: [otherServer()] });
    const plan = await planDeletion(fakeDeletionAws(account), TARGET, { ...OWNED, addedAt: ago(11) });
    expect(plan).toEqual({ instanceId: BOX, region: 'us-east-1', node: NODE, state: 'not-found', type: '', disks: [] });
    expect(await run(account, { instanceId: BOX, state: 'not-found', volumeIds: [] })).toEqual({ terminated: false, instanceId: BOX, volumeIds: [] });
    expect(writes(account)).toEqual([]);
  });

  test('a row with no instance id is never looked up in AWS', async () => {
    const account = fakeAccount();
    const aws = fakeDeletionAws(account);
    expect(await planDeletion(aws, null, OWNED)).toMatchObject({ instanceId: '', state: 'not-launched', disks: [] });
    expect(await runDeletion(aws, null, OWNED, { instanceId: '', state: 'not-launched', volumeIds: [] })).toEqual({ terminated: false, instanceId: '', volumeIds: [] });
    await expect(runDeletion(aws, null, OWNED, { instanceId: BOX, state: 'not-launched', volumeIds: [] })).rejects.toThrow('changed since the dialog opened');
    expect(account.calls).toEqual([]);
  });
});

describe('a deletion refuses, and changes nothing, when', () => {
  test('the instance carries another node tag', async () => {
    await refused(fakeAccount({ instances: [instance({ tags: { metro: 'metro-fa79qt' } }), otherServer()] }), 'is tagged metro=metro-fa79qt, not metro-thrw01');
  });

  test('the instance carries no metro tag at all', async () => {
    await refused(fakeAccount({ instances: [instance({ tags: { Name: 'web' } }), otherServer()] }), 'is tagged metro=(none)');
  });

  test('AWS does not know an instance whose row is under 10 minutes old, which may only be a launch AWS has not caught up with', async () => {
    for (const addedAt of [ago(0), ago(9.9), 'not a date']) {
      const account = fakeAccount({ instances: [otherServer()] });
      await expect(run(account, { instanceId: BOX, state: 'not-found', volumeIds: [] }, { ...OWNED, addedAt })).rejects.toThrow(`The server ${BOX} was just launched, try again in a few minutes.`);
      expect(writes(account)).toEqual([]);
    }
  });

  test('AWS is still shutting the instance down', async () => {
    const account = fakeAccount({ instances: [instance({ state: 'shutting-down' }), otherServer()] });
    await expect(run(account, { instanceId: BOX, state: 'shutting-down', volumeIds: [] })).rejects.toThrow(`AWS is still shutting down the server ${BOX}, try again in a few minutes.`);
    expect(writes(account)).toEqual([]);
  });

  test('AWS refuses to describe the instance for any other reason: the error goes up as it is', async () => {
    for (const code of ['RequestLimitExceeded', 'UnauthorizedOperation', 'AuthFailure', 'Unreachable', 'InvalidInstanceID.Malformed']) {
      const account = fakeAccount({ describeFails: new AwsError(code, 'no', 'ec2:DescribeInstances') });
      const err = await run(account).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AwsError);
      expect((err as AwsError).code).toBe(code);
      expect(writes(account)).toEqual([]);
    }
  });

  test('the instance is tagged for another agent', async () => {
    await refused(fakeAccount({ instances: [instance({ tags: { metro: NODE, 'metro:agent': 'srv00000009' } }), otherServer()] }), 'another agent');
  });

  test('AWS answers with another instance than the one asked for', async () => {
    await refused(fakeAccount({ answerFor: OTHER }), `answered with ${OTHER} when asked for ${BOX}`);
  });

  test('a disk is also attached to another server', async () => {
    await refused(fakeAccount({ volumes: [volume({ attachedTo: [BOX, OTHER], multiAttach: true }), volume({ volumeId: OTHER_DISK })] }), `attached to ${BOX}, ${OTHER}`);
  });

  test('a disk is tagged for another server or agent', async () => {
    await refused(fakeAccount({ volumes: [volume({ tags: { metro: 'metro-fa79qt' } })] }), `disk ${BOX_DISK} is tagged metro=metro-fa79qt`);
    await refused(fakeAccount({ volumes: [volume({ tags: { 'metro:agent': 'srv00000009' } })] }), 'another agent');
  });

  test('AWS describes other disks than the ones attached', async () => {
    const account = fakeAccount({ instances: [instance({ disks: [{ device: '/dev/sda1', volumeId: OTHER_DISK, deleteOnTermination: true }] }), otherServer()] });
    await refused(account, `attached to ${OTHER}, not only to ${BOX}`, { ...CONFIRMED, volumeIds: [OTHER_DISK] });
    await refused(fakeAccount({ volumes: [] }), `described the disks (none) when asked for ${BOX_DISK}`);
  });

  test('the ids or the state the dialog showed are not the ones AWS shows now', async () => {
    await refused(fakeAccount(), 'changed since the dialog opened', { ...CONFIRMED, volumeIds: [BOX_DISK, OTHER_DISK] });
    await refused(fakeAccount(), 'changed since the dialog opened', { ...CONFIRMED, volumeIds: [] });
    await refused(fakeAccount(), 'changed since the dialog opened', { ...CONFIRMED, instanceId: OTHER });
    await refused(fakeAccount(), 'changed since the dialog opened', { ...CONFIRMED, state: 'stopped' });
    await refused(fakeAccount(), 'changed since the dialog opened', { instanceId: BOX, state: 'not-found', volumeIds: [] });
    await refused(fakeAccount(), 'changed since the dialog opened', { instanceId: BOX, state: 'terminated', volumeIds: [] });
  });
});

test('an answer to TerminateInstances naming another instance is an error, not a success', async () => {
  const account = fakeAccount();
  const aws = fakeDeletionAws(account);
  aws.terminate = () => Promise.resolve([OTHER]);
  await expect(runDeletion(aws, TARGET, OWNED, CONFIRMED)).rejects.toThrow(`AWS answered the deletion of ${BOX} with ${OTHER}`);
});
