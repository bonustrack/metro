import type { AwsCredentials } from './ec2.js';
import type { Metric, MetricQuery, Point } from './cloudwatch.js';
import { AGENT_NAMESPACE, agentMetric, type UsageAws } from './usage.js';

const CPU_SECONDS = 300;
const AGENT_SECONDS = 60;
const WINDOW_MS = 15 * 60_000;
const QUERIES_MAX = 500;

export interface Latest {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
}

function latestWindow(now: number): { from: number; to: number } {
  const step = CPU_SECONDS * 1000;
  const to = Math.ceil(now / step) * step;
  return { from: to - WINDOW_MS, to };
}

const ofInstance = (metrics: Metric[], instanceId: string): Metric[] =>
  metrics.filter((m) => m.dimensions.some((d) => d.name === 'InstanceId' && d.value === instanceId));

function queriesFor(found: Metric[], instanceId: string, at: number): MetricQuery[] {
  const mine = ofInstance(found, instanceId);
  const agent: [string, Metric | undefined][] = [
    [`m${String(at)}`, agentMetric(mine, 'mem_used_percent')],
    [`d${String(at)}`, agentMetric(mine, 'disk_used_percent', '/')],
  ];
  return [
    { id: `c${String(at)}`, metric: { namespace: 'AWS/EC2', name: 'CPUUtilization', dimensions: [{ name: 'InstanceId', value: instanceId }] }, periodSeconds: CPU_SECONDS, stat: 'Average' },
    ...agent.flatMap(([id, metric]): MetricQuery[] => (metric === undefined ? [] : [{ id, metric, periodSeconds: AGENT_SECONDS, stat: 'Average' }])),
  ];
}

const last = (points: Point[] | undefined): number | null => points?.at(-1)?.value ?? null;

export async function readLatest(aws: UsageAws, credentials: AwsCredentials, region: string, instanceIds: string[], now: number): Promise<Map<string, Latest>> {
  const found = await aws.list(credentials, region, AGENT_NAMESPACE, []);
  const queries = instanceIds.flatMap((instanceId, at) => queriesFor(found, instanceId, at));
  const { from, to } = latestWindow(now);
  const chunks: MetricQuery[][] = [];
  for (let i = 0; i < queries.length; i += QUERIES_MAX) chunks.push(queries.slice(i, i + QUERIES_MAX));
  const answers = await Promise.all(chunks.map((chunk) => aws.data(credentials, region, chunk, from, to)));
  const data = new Map(answers.flatMap((answer) => [...answer]));
  return new Map(
    instanceIds.map((instanceId, at) => [
      instanceId,
      { cpu: last(data.get(`c${String(at)}`)), memory: last(data.get(`m${String(at)}`)), disk: last(data.get(`d${String(at)}`)) },
    ]),
  );
}
