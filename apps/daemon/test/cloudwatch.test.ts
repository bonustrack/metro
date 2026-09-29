import { describe, expect, test } from 'bun:test';
import { diskPercent, memoryPercent, publishOnce, readingParams, startedOf, type PublisherDeps } from '../src/server/cloudwatch.js';

const MEMINFO = 'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:   12000000 kB\nBuffers:          100 kB\n';
const KEYS = JSON.stringify({ Code: 'Success', AccessKeyId: 'ASIABOX', SecretAccessKey: 'secret', Token: 'session-token', Expiration: '2026-09-29T16:00:00Z' });

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeBox(over: Partial<Record<string, [number, string]>> = {}, readings = { memory: 25, disk: 72.06 }): { deps: PublisherDeps; sent: Sent[] } {
  const sent: Sent[] = [];
  const answers: Record<string, [number, string]> = {
    'PUT /latest/api/token': [200, 'imds-token'],
    'GET /latest/meta-data/instance-id': [200, 'i-0f465180565bf277a'],
    'GET /latest/meta-data/placement/region': [200, 'us-east-1'],
    'GET /latest/meta-data/iam/security-credentials/': [200, 'metro-box'],
    'GET /latest/meta-data/iam/security-credentials/metro-box': [200, KEYS],
    'POST /': [200, '<PutMetricDataResponse/>'],
    ...over,
  };
  const deps: PublisherDeps = {
    fetch: (url, init) => {
      const method = init.method ?? 'GET';
      sent.push({ url, method, headers: { ...(init.headers as Record<string, string>) }, body: String(init.body ?? '') });
      const answer = answers[`${method} ${new URL(url).pathname}`] ?? [404, 'not found'];
      return Promise.resolve(new Response(answer[1], { status: answer[0] }));
    },
    readings: () => Promise.resolve(readings),
  };
  return { deps, sent };
}

describe('memory and disk sent to CloudWatch', () => {
  test('memory counts what Linux can still hand out, disk is what df shows', () => {
    expect(memoryPercent(MEMINFO)).toBe(25);
    expect(memoryPercent('MemTotal: 100 kB\n')).toBeNull();
    expect(diskPercent({ blocks: 100, bfree: 30, bavail: 20 })).toBeCloseTo(77.78, 2);
    expect(diskPercent({ blocks: 0, bfree: 0, bavail: 0 })).toBeNull();
  });

  test('on EC2 with a role, the readings go to the instance region, signed with the role keys, as the CloudWatch agent names them', async () => {
    const { deps, sent } = fakeBox();
    expect(await publishOnce(deps)).toContain('sending memory and disk');
    expect(sent[0]).toMatchObject({ url: 'http://169.254.169.254/latest/api/token', method: 'PUT' });
    expect(sent[1]?.headers['x-aws-ec2-metadata-token']).toBe('imds-token');
    const put = sent.at(-1);
    expect(put?.url).toBe('https://monitoring.us-east-1.amazonaws.com/');
    expect(put?.headers['x-amz-security-token']).toBe('session-token');
    expect(put?.headers.authorization).toContain('Credential=ASIABOX/');
    expect(put?.headers.authorization).toContain('/us-east-1/monitoring/aws4_request');
    expect(Object.fromEntries(new URLSearchParams(put?.body))).toEqual(readingParams('i-0f465180565bf277a', { memory: 25, disk: 72.06 }));
    expect(readingParams('i-1', { memory: 25, disk: 72.06 })).toEqual({
      Action: 'PutMetricData',
      Version: '2010-08-01',
      Namespace: 'CWAgent',
      'MetricData.member.1.MetricName': 'mem_used_percent',
      'MetricData.member.1.Unit': 'Percent',
      'MetricData.member.1.Value': '25.00',
      'MetricData.member.1.Dimensions.member.1.Name': 'InstanceId',
      'MetricData.member.1.Dimensions.member.1.Value': 'i-1',
      'MetricData.member.2.MetricName': 'disk_used_percent',
      'MetricData.member.2.Unit': 'Percent',
      'MetricData.member.2.Value': '72.06',
      'MetricData.member.2.Dimensions.member.1.Name': 'InstanceId',
      'MetricData.member.2.Dimensions.member.1.Value': 'i-1',
      'MetricData.member.2.Dimensions.member.2.Name': 'path',
      'MetricData.member.2.Dimensions.member.2.Value': '/',
    });
  });

  test('a start goes out once with the readings: a server boot when the server is up for under 5 minutes, else a Metro restart', async () => {
    const now = Date.parse('2026-09-29T10:00:00Z');
    expect(startedOf(now, 20, 45)).toEqual({ name: 'server_booted', at: now / 1000 - 45 });
    expect(startedOf(now, 20, 86_400)).toEqual({ name: 'metro_started', at: now / 1000 - 20 });
    const { deps, sent } = fakeBox();
    const started = startedOf(now, 20, 86_400);
    expect(await publishOnce(deps, started)).toContain('sending memory and disk');
    const params = Object.fromEntries(new URLSearchParams(sent.at(-1)?.body));
    expect(params).toEqual(readingParams('i-0f465180565bf277a', { memory: 25, disk: 72.06 }, started));
    expect(params).toMatchObject({
      'MetricData.member.3.MetricName': 'metro_started',
      'MetricData.member.3.Unit': 'Seconds',
      'MetricData.member.3.Value': `${String(now / 1000 - 20)}.00`,
      'MetricData.member.3.Dimensions.member.1.Name': 'InstanceId',
      'MetricData.member.3.Dimensions.member.1.Value': 'i-0f465180565bf277a',
    });
  });

  test('a server that is not on EC2, or has no role yet, sends nothing', async () => {
    const elsewhere = fakeBox({ 'PUT /latest/api/token': [404, 'no such thing'] });
    expect(await publishOnce(elsewhere.deps)).toContain('not an EC2 instance');
    expect(elsewhere.sent).toHaveLength(1);
    const noRole = fakeBox({ 'GET /latest/meta-data/iam/security-credentials/': [404, '<html>404 - Not Found</html>'] });
    expect(await publishOnce(noRole.deps)).toContain('has no IAM role');
    expect(noRole.sent.some((s) => s.url.startsWith('https://monitoring'))).toBe(false);
  });

  test("a CloudWatch refusal is an error naming AWS's code, for the log only", async () => {
    const { deps } = fakeBox({ 'POST /': [403, '<ErrorResponse><Error><Code>AccessDenied</Code><Message>not authorized to perform cloudwatch:PutMetricData</Message></Error></ErrorResponse>'] });
    await expect(publishOnce(deps)).rejects.toThrow('CloudWatch refused the readings: AccessDenied (not authorized to perform cloudwatch:PutMetricData)');
  });
});
