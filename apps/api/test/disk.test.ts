import { afterEach, describe, expect, test } from 'bun:test';
import { AwsError } from '../src/aws/ec2.ts';
import { growVolume, lastModification, rebootInstance, tagVolumeNode } from '../src/aws/disk.ts';

const CREDS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
const BOX = 'i-0b0c0000000000001';
const DISK = 'vol-0b0c0000000000001';
const realFetch = globalThis.fetch;

function stub(xml: string, status = 200): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new URLSearchParams(String(init?.body)));
    return Promise.resolve(new Response(xml, { status, headers: { 'content-type': 'text/xml' } }));
  }) as typeof fetch;
  return seen;
}

const fields = (body: URLSearchParams | undefined): Record<string, string> => Object.fromEntries(body ?? []);

afterEach(() => {
  globalThis.fetch = realFetch;
});

const MODIFICATION = `<item><modificationState>optimizing</modificationState><targetSize>32</targetSize><targetVolumeType>gp3</targetVolumeType>
  <volumeId>${DISK}</volumeId><progress>40</progress><startTime>2026-10-01T02:00:00.000Z</startTime><originalSize>20</originalSize>
  <statusMessage>slow</statusMessage></item>`;

describe('the EC2 calls that grow a disk', () => {
  test('DescribeVolumesModifications filters on the one volume id and reads the last change', async () => {
    const seen = stub(`<DescribeVolumesModificationsResponse xmlns="x"><volumeModificationSet>${MODIFICATION}</volumeModificationSet></DescribeVolumesModificationsResponse>`);
    expect(await lastModification(CREDS, 'us-east-1', DISK)).toEqual({
      state: 'optimizing',
      progress: 40,
      originalGib: 20,
      targetGib: 32,
      startedAt: '2026-10-01T02:00:00.000Z',
      message: 'slow',
    });
    expect(fields(seen[0])).toEqual({
      Action: 'DescribeVolumesModifications',
      Version: '2016-11-15',
      'Filter.1.Name': 'volume-id',
      'Filter.1.Value.1': DISK,
    });
  });

  test('a disk never changed, or a change for another disk, is no change', async () => {
    stub('<DescribeVolumesModificationsResponse xmlns="x"><volumeModificationSet/></DescribeVolumesModificationsResponse>');
    expect(await lastModification(CREDS, 'us-east-1', DISK)).toBeNull();
    stub(`<DescribeVolumesModificationsResponse xmlns="x"><volumeModificationSet>${MODIFICATION.replace(DISK, 'vol-0a0a0000000000002')}</volumeModificationSet></DescribeVolumesModificationsResponse>`);
    expect(await lastModification(CREDS, 'us-east-1', DISK)).toBeNull();
  });

  test('ModifyVolume sends only the volume id and the new size', async () => {
    const seen = stub(`<ModifyVolumeResponse xmlns="x"><volumeModification>${MODIFICATION.replace('optimizing', 'modifying').slice(6, -7)}</volumeModification></ModifyVolumeResponse>`);
    expect((await growVolume(CREDS, 'us-east-1', DISK, 32))?.state).toBe('modifying');
    expect(fields(seen[0])).toEqual({ Action: 'ModifyVolume', Version: '2016-11-15', VolumeId: DISK, Size: '32' });
  });

  test('CreateTags writes the metro tag on the one disk, and RebootInstances names the one server', async () => {
    const seen = stub('<Response><return>true</return></Response>');
    await tagVolumeNode(CREDS, 'us-east-1', DISK, 'metro-thrw01');
    await rebootInstance(CREDS, 'us-east-1', BOX);
    expect(fields(seen[0])).toEqual({ Action: 'CreateTags', Version: '2016-11-15', 'ResourceId.1': DISK, 'Tag.1.Key': 'metro', 'Tag.1.Value': 'metro-thrw01' });
    expect(fields(seen[1])).toEqual({ Action: 'RebootInstances', Version: '2016-11-15', 'InstanceId.1': BOX });
  });

  test('a malformed id never reaches AWS, and a refusal carries the code AWS sent', async () => {
    const seen = stub('<Response/>');
    await expect(growVolume(CREDS, 'us-east-1', 'vol-*', 32)).rejects.toThrow('is not an id AWS uses');
    await expect(rebootInstance(CREDS, 'us-east-1', '')).rejects.toThrow('(empty) is not an id AWS uses');
    expect(seen).toHaveLength(0);
    stub('<Response><Errors><Error><Code>IncorrectModificationState</Code><Message>wait</Message></Error></Errors></Response>', 400);
    const err = await growVolume(CREDS, 'us-east-1', DISK, 32).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsError);
    expect(err).toMatchObject({ code: 'IncorrectModificationState', action: 'ec2:ModifyVolume', message: 'wait' });
  });
});
