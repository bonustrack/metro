import type { AwsCredentials } from './ec2.js';
import type { Dimension, Metric, MetricQuery, Point } from './cloudwatch.js';

export const USAGE_RANGES = ['1h', '24h', '7d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

interface Periods {
  ms: number;
  ec2Seconds: number;
  agentSeconds: number;
}

const PERIODS: Record<UsageRange, Periods> = {
  '1h': { ms: 3_600_000, ec2Seconds: 300, agentSeconds: 60 },
  '24h': { ms: 86_400_000, ec2Seconds: 300, agentSeconds: 300 },
  '7d': { ms: 604_800_000, ec2Seconds: 3600, agentSeconds: 3600 },
};

export const AGENT_NAMESPACE = 'CWAgent';

export interface Series {
  stepMs: number;
  points: Point[];
}

export interface Usage {
  from: number;
  to: number;
  cpu: Series;
  credits: Series;
  status: Series;
  memory: Series;
  disk: Series;
  agent: boolean;
}

export interface UsageAws {
  list: (credentials: AwsCredentials, region: string, namespace: string, dimensions: Dimension[]) => Promise<Metric[]>;
  data: (credentials: AwsCredentials, region: string, queries: MetricQuery[], from: number, to: number) => Promise<Map<string, Point[]>>;
}

export interface UsageTarget {
  instanceId: string;
  region: string;
}

const fewestDimensions = (a: Metric, b: Metric): number => a.dimensions.length - b.dimensions.length;

export function agentMetric(metrics: Metric[], name: string, path?: string): Metric | undefined {
  const onPath = (m: Metric): boolean => path === undefined || m.dimensions.some((d) => d.name === 'path' && d.value === path);
  return metrics.filter((m) => m.namespace === AGENT_NAMESPACE && m.name === name && onPath(m)).sort(fewestDimensions)[0];
}

export function usageWindow(range: UsageRange, now: number): { from: number; to: number } {
  const step = PERIODS[range].ec2Seconds * 1000;
  const to = Math.ceil(now / step) * step;
  return { from: to - PERIODS[range].ms, to };
}

export async function readUsage(aws: UsageAws, credentials: AwsCredentials, target: UsageTarget, range: UsageRange, now: number): Promise<Usage> {
  const periods = PERIODS[range];
  const { from, to } = usageWindow(range, now);
  const byInstance: Dimension[] = [{ name: 'InstanceId', value: target.instanceId }];
  const ec2 = (id: string, name: string, stat: string): MetricQuery => ({
    id,
    metric: { namespace: 'AWS/EC2', name, dimensions: byInstance },
    periodSeconds: periods.ec2Seconds,
    stat,
  });
  const found = await aws.list(credentials, target.region, AGENT_NAMESPACE, byInstance);
  const agent: [string, Metric | undefined][] = [
    ['memory', agentMetric(found, 'mem_used_percent')],
    ['disk', agentMetric(found, 'disk_used_percent', '/')],
  ];
  const queries = [
    ec2('cpu', 'CPUUtilization', 'Average'),
    ec2('credits', 'CPUCreditBalance', 'Average'),
    ec2('status', 'StatusCheckFailed', 'Maximum'),
    ...agent.flatMap(([id, metric]): MetricQuery[] => (metric === undefined ? [] : [{ id, metric, periodSeconds: periods.agentSeconds, stat: 'Average' }])),
  ];
  const data = await aws.data(credentials, target.region, queries, from, to);
  const series = (id: string, seconds: number): Series => ({ stepMs: seconds * 1000, points: data.get(id) ?? [] });
  return {
    from,
    to,
    cpu: series('cpu', periods.ec2Seconds),
    credits: series('credits', periods.ec2Seconds),
    status: series('status', periods.ec2Seconds),
    memory: series('memory', periods.agentSeconds),
    disk: series('disk', periods.agentSeconds),
    agent: agent.some(([, metric]) => metric !== undefined),
  };
}
