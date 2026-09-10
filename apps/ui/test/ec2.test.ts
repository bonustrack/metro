import { afterEach, describe, expect, test } from 'bun:test';
import { AwsError, describeInstance, describeZones, latestUbuntuArm64Image, pickImage, runInstance, runInstanceParams, toBase64 } from '../src/aws/ec2.ts';

const CREDS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
const realFetch = globalThis.fetch;

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

function stub(status: number, xml: string): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: new URLSearchParams(String(init?.body)),
    });
    return Promise.resolve(new Response(xml, { status, headers: { 'content-type': 'text/xml' } }));
  }) as typeof fetch;
  return seen;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const IMAGES = `<DescribeImagesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><imagesSet>
  <item><imageId>ami-old</imageId><name>ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20240423</name><creationDate>2024-04-23T10:00:00.000Z</creationDate></item>
  <item><imageId>ami-gp2</imageId><name>ubuntu/images/hvm-ssd/ubuntu-noble-24.04-arm64-server-20260901</name><creationDate>2026-09-01T10:00:00.000Z</creationDate></item>
  <item><imageId>ami-new</imageId><name>ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20260820</name><creationDate>2026-08-20T10:00:00.000Z</creationDate></item>
</imagesSet></DescribeImagesResponse>`;

describe('EC2 from the browser', () => {
  test('DescribeImages asks Canonical for noble arm64 and picks the newest gp3 image', async () => {
    const seen = stub(200, IMAGES);
    const image = await latestUbuntuArm64Image(CREDS, 'eu-west-1');
    expect(image.imageId).toBe('ami-new');
    const req = seen[0];
    expect(req?.url).toBe('https://ec2.eu-west-1.amazonaws.com/');
    expect(req?.method).toBe('POST');
    expect(req?.body.get('Action')).toBe('DescribeImages');
    expect(req?.body.get('Version')).toBe('2016-11-15');
    expect(req?.body.get('Owner.1')).toBe('099720109477');
    expect(req?.body.get('Filter.1.Value.1')).toContain('ubuntu-noble-24.04-arm64-server-');
    expect(req?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/eu-west-1\/ec2\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(req?.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
  });

  test('the image choice prefers gp3 and then the newest, and refuses an empty list', () => {
    expect(pickImage([])).toBeNull();
    expect(pickImage([{ imageId: '', name: 'x', creationDate: '2030' }])).toBeNull();
  });

  test('RunInstances carries the exact machine shape and the user data as base64', async () => {
    const seen = stub(200, '<RunInstancesResponse xmlns="x"><reservationId>r-1</reservationId><instancesSet><item><instanceId>i-0abc</instanceId><instanceState><code>0</code><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>');
    const spec = { imageId: 'ami-new', name: 'Andy', node: 'metro-andy', userData: '#!/bin/bash\necho hi ✓\n', clientToken: 'tok-1' };
    expect(await runInstance(CREDS, 'eu-west-1', spec)).toBe('i-0abc');
    const body = seen[0]?.body ?? new URLSearchParams();
    expect(body.get('Action')).toBe('RunInstances');
    expect(body.get('InstanceType')).toBe('t4g.medium');
    expect(body.get('MinCount')).toBe('1');
    expect(body.get('MaxCount')).toBe('1');
    expect(body.get('ClientToken')).toBe('tok-1');
    expect(body.get('BlockDeviceMapping.1.DeviceName')).toBe('/dev/sda1');
    expect(body.get('BlockDeviceMapping.1.Ebs.VolumeSize')).toBe('8');
    expect(body.get('BlockDeviceMapping.1.Ebs.VolumeType')).toBe('gp3');
    expect(body.get('MetadataOptions.HttpTokens')).toBe('required');
    expect(body.get('TagSpecification.1.Tag.1.Value')).toBe('Andy');
    expect(body.get('TagSpecification.1.Tag.2.Value')).toBe('metro-andy');
    expect(Buffer.from(body.get('UserData') ?? '', 'base64').toString('utf8')).toBe(spec.userData);
    expect(runInstanceParams(spec).ImageId).toBe('ami-new');
    expect(runInstanceParams(spec)).not.toHaveProperty('Placement.AvailabilityZone');
    expect(runInstanceParams({ ...spec, zone: 'eu-west-1b' })['Placement.AvailabilityZone']).toBe('eu-west-1b');
    expect(toBase64('é')).toBe('w6k=');
  });

  test('DescribeAvailabilityZones lists the available zones of the region, sorted', async () => {
    const seen = stub(200, '<DescribeAvailabilityZonesResponse xmlns="x"><availabilityZoneInfo><item><zoneName>eu-west-1c</zoneName><zoneState>available</zoneState></item><item><zoneName>eu-west-1a</zoneName><zoneState>available</zoneState></item></availabilityZoneInfo></DescribeAvailabilityZonesResponse>');
    expect(await describeZones(CREDS, 'eu-west-1')).toEqual(['eu-west-1a', 'eu-west-1c']);
    expect(seen[0]?.body.get('Action')).toBe('DescribeAvailabilityZones');
    expect(seen[0]?.body.get('Filter.2.Value.1')).toBe('availability-zone');
  });

  test('an AWS refusal is its own code and message', async () => {
    stub(401, '<Response><Errors><Error><Code>AuthFailure</Code><Message>AWS was not able to validate the provided access credentials</Message></Error></Errors><RequestID>r</RequestID></Response>');
    const err = await latestUbuntuArm64Image(CREDS, 'eu-west-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsError);
    expect((err as AwsError).code).toBe('AuthFailure');
    expect((err as Error).message).toContain('not able to validate');
  });

  test('DescribeInstances reads the state and the public address', async () => {
    const seen = stub(200, '<DescribeInstancesResponse xmlns="x"><reservationSet><item><instancesSet><item><instanceId>i-0abc</instanceId><instanceState><code>16</code><name>running</name></instanceState><ipAddress>3.4.5.6</ipAddress></item></instancesSet></item></reservationSet></DescribeInstancesResponse>');
    expect(await describeInstance(CREDS, 'eu-west-1', 'i-0abc')).toEqual({ instanceId: 'i-0abc', state: 'running', publicIp: '3.4.5.6' });
    expect(seen[0]?.body.get('InstanceId.1')).toBe('i-0abc');
    stub(200, '<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>');
    await expect(describeInstance(CREDS, 'eu-west-1', 'i-gone')).rejects.toThrow('no longer lists');
  });

  test('an unreachable endpoint is a clear error', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('boom'))) as typeof fetch;
    const err = await describeInstance(CREDS, 'eu-west-1', 'i-0abc').catch((e: unknown) => e);
    expect((err as AwsError).code).toBe('Unreachable');
  });
});
