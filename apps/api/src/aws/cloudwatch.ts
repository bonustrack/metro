import { awsQuery, AwsError, type AwsCredentials, type QueryService } from './ec2.js';
import { child, children, textAt, type XmlNode } from './xml.js';

const CLOUDWATCH_VERSION = '2010-08-01';
const LIST_PAGES_MAX = 10;
const ROLE_SECONDS = 900;

const cloudwatch = (region: string): QueryService => ({
  host: `monitoring.${region}.amazonaws.com`,
  region,
  signingName: 'monitoring',
  iamPrefix: 'cloudwatch',
  version: CLOUDWATCH_VERSION,
  label: `CloudWatch in ${region}`,
});

const STS: QueryService = { host: 'sts.us-east-1.amazonaws.com', region: 'us-east-1', signingName: 'sts', iamPrefix: 'sts', version: '2011-06-15', label: 'AWS STS' };

export interface Dimension {
  name: string;
  value: string;
}

export interface Metric {
  namespace: string;
  name: string;
  dimensions: Dimension[];
}

export interface MetricQuery {
  id: string;
  metric: Metric;
  periodSeconds: number;
  stat: string;
}

export interface Point {
  at: number;
  value: number;
}

const dimensionParams = (prefix: string, dimensions: Dimension[]): [string, string][] =>
  dimensions.flatMap((d, i): [string, string][] => [
    [`${prefix}.member.${String(i + 1)}.Name`, d.name],
    [`${prefix}.member.${String(i + 1)}.Value`, d.value],
  ]);

const metricOf = (node: XmlNode): Metric => ({
  namespace: textAt(node, 'Namespace'),
  name: textAt(node, 'MetricName'),
  dimensions: children(child(node, 'Dimensions'), 'member').map((d) => ({ name: textAt(d, 'Name'), value: textAt(d, 'Value') })),
});

export async function listMetrics(credentials: AwsCredentials, region: string, namespace: string, dimensions: Dimension[]): Promise<Metric[]> {
  const params = Object.fromEntries([['Namespace', namespace], ...dimensionParams('Dimensions', dimensions)]);
  const found: Metric[] = [];
  let token = '';
  for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
    const xml = await awsQuery(credentials, cloudwatch(region), 'ListMetrics', token === '' ? params : { ...params, NextToken: token });
    const result = child(xml, 'ListMetricsResult');
    found.push(...children(child(result, 'Metrics'), 'member').map(metricOf));
    token = textAt(result, 'NextToken');
    if (token === '') break;
  }
  return found;
}

function queryParams(queries: MetricQuery[]): [string, string][] {
  return queries.flatMap((q, i): [string, string][] => {
    const at = `MetricDataQueries.member.${String(i + 1)}`;
    return [
      [`${at}.Id`, q.id],
      [`${at}.MetricStat.Metric.Namespace`, q.metric.namespace],
      [`${at}.MetricStat.Metric.MetricName`, q.metric.name],
      ...dimensionParams(`${at}.MetricStat.Metric.Dimensions`, q.metric.dimensions),
      [`${at}.MetricStat.Period`, String(q.periodSeconds)],
      [`${at}.MetricStat.Stat`, q.stat],
      [`${at}.ReturnData`, 'true'],
    ];
  });
}

function pointsOf(node: XmlNode): Point[] {
  const times = children(child(node, 'Timestamps'), 'member').map((m) => Date.parse(m.text.trim()));
  const values = children(child(node, 'Values'), 'member').map((m) => Number(m.text.trim()));
  return times
    .map((at, i) => ({ at, value: values[i] ?? NaN }))
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.value))
    .sort((a, b) => a.at - b.at);
}

export async function getMetricData(credentials: AwsCredentials, region: string, queries: MetricQuery[], from: number, to: number): Promise<Map<string, Point[]>> {
  const params = Object.fromEntries([
    ['StartTime', new Date(from).toISOString()],
    ['EndTime', new Date(to).toISOString()],
    ['ScanBy', 'TimestampAscending'],
    ...queryParams(queries),
  ]);
  const xml = await awsQuery(credentials, cloudwatch(region), 'GetMetricData', params);
  const results = children(child(child(xml, 'GetMetricDataResult'), 'MetricDataResults'), 'member');
  return new Map(results.map((r) => [textAt(r, 'Id'), pointsOf(r)]));
}

export interface RoleCredentials extends AwsCredentials {
  expiresAt: number;
}

export async function assumeRole(credentials: AwsCredentials, roleArn: string): Promise<RoleCredentials> {
  const xml = await awsQuery(credentials, STS, 'AssumeRole', { RoleArn: roleArn, RoleSessionName: 'metro-usage', DurationSeconds: String(ROLE_SECONDS) });
  const found = child(child(xml, 'AssumeRoleResult'), 'Credentials');
  const role = {
    accessKeyId: textAt(found, 'AccessKeyId'),
    secretAccessKey: textAt(found, 'SecretAccessKey'),
    sessionToken: textAt(found, 'SessionToken'),
    expiresAt: Date.parse(textAt(found, 'Expiration')),
  };
  if (role.accessKeyId === '' || role.secretAccessKey === '' || role.sessionToken === '' || !Number.isFinite(role.expiresAt))
    throw new AwsError('NoCredentials', `AWS STS answered without credentials for ${roleArn}.`, 'sts:AssumeRole');
  return role;
}
