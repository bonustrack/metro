import { afterEach, describe, expect, test } from 'bun:test';
import { AwsError } from '../src/aws/ec2.ts';
import { deleteDiskWithServer, describeInstanceFacts, describeVolumeFacts, terminateInstance } from '../src/aws/teardown.ts';

const CREDS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
const BOX = 'i-0b0c0000000000001';
const DISK = 'vol-0b0c0000000000001';
const realFetch = globalThis.fetch;

function stub(status: number, xml: string): URLSearchParams[] {
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

const INSTANCE = `<DescribeInstancesResponse xmlns="x"><reservationSet><item><instancesSet><item>
  <instanceId>${BOX}</instanceId><instanceState><code>16</code><name>running</name></instanceState><instanceType>t4g.medium</instanceType>
  <blockDeviceMapping><item><deviceName>/dev/sda1</deviceName><ebs><volumeId>${DISK}</volumeId><status>attached</status><deleteOnTermination>true</deleteOnTermination></ebs></item></blockDeviceMapping>
  <tagSet><item><key>Name</key><value>metro:throwaway</value></item><item><key>metro</key><value>metro-thrw01</value></item></tagSet>
</item></instancesSet></item></reservationSet></DescribeInstancesResponse>`;

const VOLUMES = `<DescribeVolumesResponse xmlns="x"><volumeSet><item><volumeId>${DISK}</volumeId><size>8</size><status>in-use</status>
  <attachmentSet><item><volumeId>${DISK}</volumeId><instanceId>${BOX}</instanceId><device>/dev/sda1</device><status>attached</status><deleteOnTermination>true</deleteOnTermination></item></attachmentSet>
  <tagSet><item><key>metro</key><value>metro-thrw01</value></item></tagSet><multiAttachEnabled>false</multiAttachEnabled>
</item></volumeSet></DescribeVolumesResponse>`;

describe('the EC2 calls of a deletion name exact ids and never a filter', () => {
  test('DescribeInstances asks for the one instance id and reads its state, tags and disks', async () => {
    const seen = stub(200, INSTANCE);
    expect(await describeInstanceFacts(CREDS, 'us-east-1', BOX)).toEqual([
      {
        instanceId: BOX,
        state: 'running',
        type: 't4g.medium',
        tags: { Name: 'metro:throwaway', metro: 'metro-thrw01' },
        disks: [{ device: '/dev/sda1', volumeId: DISK, deleteOnTermination: true }],
        profile: null,
      },
    ]);
    expect(fields(seen[0])).toEqual({ Action: 'DescribeInstances', Version: '2016-11-15', 'InstanceId.1': BOX });
  });

  test('every refusal, NotFound included, is an AwsError that carries the code AWS sent', async () => {
    for (const [status, code] of [
      [400, 'InvalidInstanceID.NotFound'],
      [403, 'UnauthorizedOperation'],
      [503, 'RequestLimitExceeded'],
    ] as const) {
      stub(status, `<Response><Errors><Error><Code>${code}</Code><Message>no</Message></Error></Errors></Response>`);
      const err = await describeInstanceFacts(CREDS, 'us-east-1', BOX).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AwsError);
      expect((err as AwsError).code).toBe(code);
    }
  });

  test('DescribeVolumes asks for the exact volume ids and reads size, attachments and tags', async () => {
    const seen = stub(200, VOLUMES);
    expect(await describeVolumeFacts(CREDS, 'us-east-1', [DISK])).toEqual([
      { volumeId: DISK, sizeGib: 8, state: 'in-use', tags: { metro: 'metro-thrw01' }, attachedTo: [BOX], multiAttach: false },
    ]);
    expect(fields(seen[0])).toEqual({ Action: 'DescribeVolumes', Version: '2016-11-15', 'VolumeId.1': DISK });
    expect(await describeVolumeFacts(CREDS, 'us-east-1', [])).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  test('TerminateInstances names the one instance id and answers the ids AWS terminates', async () => {
    const seen = stub(200, `<TerminateInstancesResponse xmlns="x"><instancesSet><item><instanceId>${BOX}</instanceId><currentState><name>shutting-down</name></currentState></item></instancesSet></TerminateInstancesResponse>`);
    expect(await terminateInstance(CREDS, 'us-east-1', BOX)).toEqual([BOX]);
    expect(fields(seen[0])).toEqual({ Action: 'TerminateInstances', Version: '2016-11-15', 'InstanceId.1': BOX });
  });

  test('a disk is set to go with its server by instance id and device only', async () => {
    const seen = stub(200, '<ModifyInstanceAttributeResponse xmlns="x"><return>true</return></ModifyInstanceAttributeResponse>');
    await deleteDiskWithServer(CREDS, 'us-east-1', BOX, '/dev/sda1');
    expect(fields(seen[0])).toEqual({
      Action: 'ModifyInstanceAttribute',
      Version: '2016-11-15',
      InstanceId: BOX,
      'BlockDeviceMapping.1.DeviceName': '/dev/sda1',
      'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
    });
  });

  test('an id that is not an AWS id never reaches AWS', async () => {
    const seen = stub(200, '<x/>');
    await expect(terminateInstance(CREDS, 'us-east-1', '')).rejects.toThrow('is not an id AWS uses');
    await expect(terminateInstance(CREDS, 'us-east-1', 'i-*')).rejects.toThrow('is not an id AWS uses');
    await expect(describeInstanceFacts(CREDS, 'us-east-1', 'i-0b0c&Filter.1.Name=tag:metro')).rejects.toThrow('is not an id AWS uses');
    await expect(describeVolumeFacts(CREDS, 'us-east-1', [DISK, 'vol-*'])).rejects.toThrow('is not an id AWS uses');
    expect(seen).toEqual([]);
  });
});
