import { readFile, statfs } from 'node:fs/promises';
import { uptime } from 'node:os';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { signV4 } from '@metro-labs/http/sigv4';

const IMDS = 'http://169.254.169.254/latest';
const EVERY_MS = 60_000;
const FIRST_MS = 15_000;
const IMDS_TIMEOUT_MS = 2_000;
const SEND_TIMEOUT_MS = 15_000;
const NAMESPACE = 'CWAgent';
const CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';
const BOOT_WINDOW_S = 300;
const SENT = 'sending memory and disk to CloudWatch every minute';

export interface Readings {
  memory: number;
  disk: number;
}

export interface Started {
  name: 'server_booted' | 'metro_started';
  at: number;
}

interface RoleKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

interface Instance {
  instanceId: string;
  region: string;
  keys: RoleKeys | null;
}

export interface PublisherDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  readings: () => Promise<Readings | null>;
}

export function memoryPercent(meminfo: string): number | null {
  const kb = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(meminfo);
    return match === null ? null : Number(match[1]);
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (total === null || available === null || total <= 0) return null;
  return ((total - available) / total) * 100;
}

export function diskPercent(fs: { blocks: number; bfree: number; bavail: number }): number | null {
  const used = fs.blocks - fs.bfree;
  const room = used + fs.bavail;
  return room > 0 ? (used / room) * 100 : null;
}

async function liveReadings(): Promise<Readings | null> {
  const memory = memoryPercent(await readFile('/proc/meminfo', 'utf8'));
  const disk = diskPercent(await statfs('/'));
  return memory === null || disk === null ? null : { memory, disk };
}

const LIVE: PublisherDeps = { fetch: (url, init) => fetch(url, init), readings: liveReadings };

async function imdsGet(deps: PublisherDeps, token: string, path: string): Promise<string> {
  const res = await deps.fetch(`${IMDS}/${path}`, { headers: { 'x-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(IMDS_TIMEOUT_MS) });
  return res.ok ? (await res.text()).trim() : '';
}

async function imdsToken(deps: PublisherDeps): Promise<string> {
  try {
    const res = await deps.fetch(`${IMDS}/api/token`, {
      method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '300' },
      signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
    });
    return res.ok ? (await res.text()).trim() : '';
  } catch {
    return '';
  }
}

function keysOf(raw: string): RoleKeys | null {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return null;
  const { AccessKeyId: accessKeyId, SecretAccessKey: secretAccessKey, Token: sessionToken } = parsed;
  if (typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string' || typeof sessionToken !== 'string') return null;
  return { accessKeyId, secretAccessKey, sessionToken };
}

export async function thisInstance(deps: PublisherDeps): Promise<Instance | null> {
  const token = await imdsToken(deps);
  if (token === '') return null;
  const instanceId = await imdsGet(deps, token, 'meta-data/instance-id');
  const region = await imdsGet(deps, token, 'meta-data/placement/region');
  if (instanceId === '' || region === '') return null;
  const role = (await imdsGet(deps, token, 'meta-data/iam/security-credentials/')).split('\n')[0] ?? '';
  if (role === '') return { instanceId, region, keys: null };
  return { instanceId, region, keys: keysOf(await imdsGet(deps, token, `meta-data/iam/security-credentials/${role}`)) };
}

export function startedOf(nowMs: number, processSeconds: number, bootSeconds: number): Started {
  const at = (secondsAgo: number): number => Math.round(nowMs / 1000 - secondsAgo);
  return bootSeconds < BOOT_WINDOW_S ? { name: 'server_booted', at: at(bootSeconds) } : { name: 'metro_started', at: at(processSeconds) };
}

export function readingParams(instanceId: string, readings: Readings, started: Started | null = null): Record<string, string> {
  const datum = (at: number, name: string, value: number, dims: [string, string][], unit = 'Percent'): [string, string][] => [
    [`MetricData.member.${String(at)}.MetricName`, name],
    [`MetricData.member.${String(at)}.Unit`, unit],
    [`MetricData.member.${String(at)}.Value`, value.toFixed(2)],
    ...dims.flatMap(([key, v], i): [string, string][] => [
      [`MetricData.member.${String(at)}.Dimensions.member.${String(i + 1)}.Name`, key],
      [`MetricData.member.${String(at)}.Dimensions.member.${String(i + 1)}.Value`, v],
    ]),
  ];
  return Object.fromEntries([
    ['Action', 'PutMetricData'],
    ['Version', '2010-08-01'],
    ['Namespace', NAMESPACE],
    ...datum(1, 'mem_used_percent', readings.memory, [['InstanceId', instanceId]]),
    ...datum(2, 'disk_used_percent', readings.disk, [
      ['InstanceId', instanceId],
      ['path', '/'],
    ]),
    ...(started === null ? [] : datum(3, started.name, started.at, [['InstanceId', instanceId]], 'Seconds')),
  ]);
}

async function send(deps: PublisherDeps, instance: Instance, keys: RoleKeys, readings: Readings, started: Started | null): Promise<void> {
  const url = `https://monitoring.${instance.region}.amazonaws.com/`;
  const body = new URLSearchParams(readingParams(instance.instanceId, readings, started)).toString();
  const signed = await signV4({ method: 'POST', url, headers: { 'content-type': CONTENT_TYPE }, body, region: instance.region, service: 'monitoring', ...keys });
  const res = await deps.fetch(url, { method: 'POST', headers: signed.headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  if (res.ok) return;
  const text = await res.text();
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP ${String(res.status)}`;
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
  throw new Error(`CloudWatch refused the readings: ${code}${message === undefined ? '' : ` (${message})`}`);
}

export async function publishOnce(deps: PublisherDeps = LIVE, started: Started | null = null): Promise<string> {
  const instance = await thisInstance(deps);
  if (instance === null) return 'off: this server is not an EC2 instance';
  if (instance.keys === null) return `waiting: instance ${instance.instanceId} has no IAM role, so memory and disk are not sent`;
  const readings = await deps.readings();
  if (readings === null) return 'skipped: could not read memory or disk';
  await send(deps, instance, instance.keys, readings, started);
  return SENT;
}

export function startCloudWatchPublisher(): void {
  if (process.platform !== 'linux') return;
  let started: Started | null = startedOf(Date.now(), process.uptime(), uptime());
  let last = '';
  const note = (status: string, warn: boolean): void => {
    if (status === last) return;
    last = status;
    if (warn) log.warn({ status }, 'cloudwatch: could not send memory and disk');
    else log.info({ status }, 'cloudwatch');
  };
  const run = (): void => {
    publishOnce(LIVE, started)
      .then((status) => {
        if (status === SENT) started = null;
        note(status, false);
      })
      .catch((err: unknown) => {
        note(errMsg(err), true);
      });
  };
  setTimeout(run, FIRST_MS).unref?.();
  setInterval(run, EVERY_MS).unref?.();
}
