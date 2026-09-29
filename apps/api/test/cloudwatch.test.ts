import { afterEach, describe, expect, test } from 'bun:test';
import { assumeRole, getMetricData, listMetrics } from '../src/aws/cloudwatch.ts';
import { associateProfile, AwsError, runInstanceParams } from '../src/aws/ec2.ts';

const CREDS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
const realFetch = globalThis.fetch;

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

function stub(status: number, xml: string): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: new URLSearchParams(String(init?.body)) });
    return Promise.resolve(new Response(xml, { status, headers: { 'content-type': 'text/xml' } }));
  }) as typeof fetch;
  return seen;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const LIST = `<ListMetricsResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/"><ListMetricsResult><Metrics>
  <member><Namespace>CWAgent</Namespace><MetricName>mem_used_percent</MetricName><Dimensions><member><Name>InstanceId</Name><Value>i-0abc</Value></member></Dimensions></member>
  <member><Namespace>CWAgent</Namespace><MetricName>disk_used_percent</MetricName><Dimensions><member><Name>InstanceId</Name><Value>i-0abc</Value></member><member><Name>path</Name><Value>/</Value></member></Dimensions></member>
</Metrics></ListMetricsResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></ListMetricsResponse>`;

const DATA = `<GetMetricDataResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/"><GetMetricDataResult><MetricDataResults>
  <member><Id>cpu</Id><Label>CPUUtilization</Label><StatusCode>Complete</StatusCode>
    <Timestamps><member>2026-09-29T10:05:00Z</member><member>2026-09-29T10:00:00Z</member></Timestamps>
    <Values><member>12.5</member><member>3</member></Values></member>
  <member><Id>status</Id><StatusCode>Complete</StatusCode><Timestamps/><Values/></member>
</MetricDataResults><Messages/></GetMetricDataResult></GetMetricDataResponse>`;

describe('CloudWatch through its query API', () => {
  test('ListMetrics asks for the namespace and the instance, and reads every metric with its dimensions', async () => {
    const seen = stub(200, LIST);
    const found = await listMetrics(CREDS, 'eu-central-2', 'CWAgent', [{ name: 'InstanceId', value: 'i-0abc' }]);
    expect(found.map((m) => [m.name, m.dimensions.map((d) => `${d.name}=${d.value}`).join(',')])).toEqual([
      ['mem_used_percent', 'InstanceId=i-0abc'],
      ['disk_used_percent', 'InstanceId=i-0abc,path=/'],
    ]);
    expect(seen[0]?.url).toBe('https://monitoring.eu-central-2.amazonaws.com/');
    expect(Object.fromEntries(seen[0]?.body ?? [])).toEqual({
      Action: 'ListMetrics',
      Version: '2010-08-01',
      Namespace: 'CWAgent',
      'Dimensions.member.1.Name': 'InstanceId',
      'Dimensions.member.1.Value': 'i-0abc',
    });
    expect(seen[0]?.headers.authorization).toContain('/eu-central-2/monitoring/aws4_request');
  });

  test('GetMetricData sends each query with its period and statistic, and answers points in time order', async () => {
    const seen = stub(200, DATA);
    const metric = { namespace: 'AWS/EC2', name: 'CPUUtilization', dimensions: [{ name: 'InstanceId', value: 'i-0abc' }] };
    const from = Date.parse('2026-09-29T09:10:00Z');
    const data = await getMetricData(CREDS, 'us-east-1', [{ id: 'cpu', metric, periodSeconds: 300, stat: 'Average' }], from, from + 3_600_000);
    expect(data.get('cpu')).toEqual([
      { at: Date.parse('2026-09-29T10:00:00Z'), value: 3 },
      { at: Date.parse('2026-09-29T10:05:00Z'), value: 12.5 },
    ]);
    expect(data.get('status')).toEqual([]);
    const body = Object.fromEntries(seen[0]?.body ?? []);
    expect(body).toMatchObject({
      Action: 'GetMetricData',
      StartTime: '2026-09-29T09:10:00.000Z',
      EndTime: '2026-09-29T10:10:00.000Z',
      'MetricDataQueries.member.1.Id': 'cpu',
      'MetricDataQueries.member.1.MetricStat.Metric.Namespace': 'AWS/EC2',
      'MetricDataQueries.member.1.MetricStat.Metric.MetricName': 'CPUUtilization',
      'MetricDataQueries.member.1.MetricStat.Metric.Dimensions.member.1.Value': 'i-0abc',
      'MetricDataQueries.member.1.MetricStat.Period': '300',
      'MetricDataQueries.member.1.MetricStat.Stat': 'Average',
    });
  });

  test("a refusal in CloudWatch's error shape keeps its code and names the IAM action", async () => {
    stub(403, '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>not allowed</Message></Error><RequestId>r</RequestId></ErrorResponse>');
    const err = await listMetrics(CREDS, 'us-east-1', 'CWAgent', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsError);
    expect(err).toMatchObject({ code: 'AccessDenied', action: 'cloudwatch:ListMetrics', message: 'not allowed' });
  });

  test('AssumeRole answers temporary keys, and a call made with them carries the session token', async () => {
    const seen = stub(
      200,
      '<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIATEMP</AccessKeyId><SecretAccessKey>s2</SecretAccessKey><SessionToken>tok</SessionToken><Expiration>2026-09-29T11:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>',
    );
    const role = await assumeRole(CREDS, 'arn:aws:iam::123456789012:role/metro-cloudwatch-read');
    expect(role).toEqual({ accessKeyId: 'ASIATEMP', secretAccessKey: 's2', sessionToken: 'tok', expiresAt: Date.parse('2026-09-29T11:00:00Z') });
    expect(seen[0]?.url).toBe('https://sts.us-east-1.amazonaws.com/');
    expect(seen[0]?.body.get('RoleArn')).toBe('arn:aws:iam::123456789012:role/metro-cloudwatch-read');
    const next = stub(200, LIST);
    await listMetrics(role, 'us-east-1', 'CWAgent', []);
    expect(next[0]?.headers['x-amz-security-token']).toBe('tok');
    stub(200, '<AssumeRoleResponse><AssumeRoleResult/></AssumeRoleResponse>');
    await expect(assumeRole(CREDS, 'arn:aws:iam::123456789012:role/x')).rejects.toThrow('without credentials');
  });

  test('a new server asks for the metro-box role, and an existing one gets it by name', async () => {
    const spec = { imageId: 'ami-new', name: 'metro:andy', node: 'metro-andy', agent: 'srv00000001', userData: '#!/bin/bash', clientToken: 't' };
    expect(runInstanceParams({ ...spec, role: 'metro-box' })['IamInstanceProfile.Name']).toBe('metro-box');
    expect(runInstanceParams(spec)).not.toHaveProperty('IamInstanceProfile.Name');
    const seen = stub(200, '<AssociateIamInstanceProfileResponse/>');
    await associateProfile(CREDS, 'us-east-1', 'i-0abc', 'metro-box');
    expect(Object.fromEntries(seen[0]?.body ?? [])).toMatchObject({ Action: 'AssociateIamInstanceProfile', InstanceId: 'i-0abc', 'IamInstanceProfile.Name': 'metro-box' });
  });
});
