import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import type { Session, SigningKeys } from '@metro-labs/http/workos-token';
import type { ConfigResult } from './launch-config.js';
import type { ServerLaunch } from './db/servers.js';
import { AWS_REFUSED, AwsError, type InstanceState } from './aws/ec2.js';
import { catalogFor, type Catalog, type SizeDeps } from './aws/sizes.js';
import { handleServerRoute } from './server-route.js';
import { explain, jobRunning, newJob, runResize, type Ec2Target, type ResizeAws, type ResizeJob } from './aws/resize.js';

const PATH_RE = /^\/api\/servers\/([^/]+)\/size\/?$/;
const JOB_SHOWN_MS = 60 * 60_000;
const TYPE_RE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
const OFF = 'This Metro deployment has no AWS account, so it cannot change the size of a server.';
const NOT_LAUNCHED =
  'Metro did not launch this server on AWS, so it cannot change its size. A server hosted elsewhere, such as on DigitalOcean, is resized where it is hosted.';

export interface SizeApiDeps {
  config: () => ConfigResult;
  lookup: (owner: string, id: string) => Promise<ServerLaunch | null>;
  aws: ResizeAws;
  sizes: SizeDeps;
  growing: (region: string, instanceId: string) => boolean;
  keys: SigningKeys;
}

const jobs = new Map<string, ResizeJob>();
const claims = new Set<string>();

export function resetSizeState(): void {
  jobs.clear();
  claims.clear();
}

const keyOf = (target: Pick<Ec2Target, 'region' | 'instanceId'>): string => `${target.region}/${target.instanceId}`;

export const resizing = (region: string, instanceId: string): boolean => {
  const key = keyOf({ region, instanceId });
  return claims.has(key) || jobRunning(jobs.get(key));
};

export async function fromAws<T>(work: () => Promise<T>, type = ''): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AwsError) throw new ApiError(explain(err, type), AWS_REFUSED);
    throw err;
  }
}

async function targetOf(deps: SizeApiDeps, owner: string, id: string): Promise<Ec2Target | string> {
  const launch = await deps.lookup(owner, id);
  const config = deps.config();
  if (!config.ok) return OFF;
  if (launch === null) return NOT_LAUNCHED;
  return { credentials: config.config.credentials, region: launch.region, instanceId: launch.instanceId };
}

interface Read {
  target: Ec2Target;
  instance: InstanceState;
  catalog: Catalog;
}

async function read(deps: SizeApiDeps, target: Ec2Target): Promise<Read> {
  const instance = await fromAws(() => deps.aws.describe(target));
  const catalog = await fromAws(() => catalogFor(deps.sizes, target.credentials, target.region, instance.architecture, instance.type));
  return { target, instance, catalog };
}

function shownJob(target: Ec2Target, now: number): ResizeJob | null {
  const job = jobs.get(keyOf(target));
  if (job === undefined) return null;
  return jobRunning(job) || now - Date.parse(job.finishedAt ?? '') < JOB_SHOWN_MS ? job : null;
}

function viewOf({ target, instance, catalog }: Read, now: number): unknown {
  return {
    resizable: true,
    region: target.region,
    instanceId: target.instanceId,
    state: instance.state,
    type: instance.type,
    architecture: instance.architecture,
    current: catalog.current ?? { type: instance.type, vcpus: null, memoryMib: null, hourlyUsd: null },
    options: catalog.options,
    job: shownJob(target, now),
  };
}

async function overview(deps: SizeApiDeps, owner: string, id: string): Promise<unknown> {
  const target = await targetOf(deps, owner, id);
  if (typeof target === 'string') return { resizable: false, reason: target };
  return viewOf(await read(deps, target), deps.aws.now());
}

function typeOf(body: unknown): string {
  const type = isRecord(body) && typeof body.type === 'string' ? body.type.trim() : '';
  if (!TYPE_RE.test(type)) throw new ApiError('the size is an EC2 instance type, as in t4g.large', 400);
  return type;
}

function checkRequest(seen: Read, type: string): void {
  const { state, type: current } = seen.instance;
  if (state !== 'running' && state !== 'stopped') throw new ApiError(`the server is ${state} in AWS. Try again once it is running or stopped`, 409);
  if (type === current) {
    if (state === 'running') throw new ApiError(`the server already runs as ${type}`, 400);
    return;
  }
  if (!seen.catalog.options.some((size) => size.type === type)) throw new ApiError(`${type} is not one of the sizes offered for this server`, 400);
}

function launchJob(deps: SizeApiDeps, seen: Read, type: string): void {
  const job = newJob(seen.instance.type, type, seen.instance.state, deps.aws.now());
  jobs.set(keyOf(seen.target), job);
  log.info({ region: seen.target.region, instance: seen.target.instanceId, from: job.from, to: job.to }, 'size: resize started');
  runResize(deps.aws, seen.target, job)
    .then(() => {
      log.info({ instance: seen.target.instanceId, from: job.from, to: job.to, phase: job.phase, error: job.error }, 'size: resize finished');
    })
    .catch((err: unknown) => {
      job.phase = 'failed';
      job.error = `The resize stopped unexpectedly: ${errMsg(err)}`;
      job.finishedAt = new Date(deps.aws.now()).toISOString();
      log.warn({ instance: seen.target.instanceId, err: errMsg(err) }, 'size: resize crashed');
    });
}

async function resize(deps: SizeApiDeps, session: Session, owner: string, id: string, body: unknown): Promise<unknown> {
  if (session.role !== 'admin') throw new ApiError('changing the size needs the admin role in your organization', 403);
  const type = typeOf(body);
  const target = await targetOf(deps, owner, id);
  if (typeof target === 'string') throw new ApiError(target, 400);
  const key = keyOf(target);
  if (claims.has(key) || jobRunning(jobs.get(key))) throw new ApiError('this server is already changing size. Wait for it to finish', 409);
  if (deps.growing(target.region, target.instanceId)) throw new ApiError('the disk of this server is growing. Wait for it to finish', 409);
  claims.add(key);
  try {
    const seen = await read(deps, target);
    checkRequest(seen, type);
    launchJob(deps, seen, type);
    return viewOf(seen, deps.aws.now());
  } finally {
    claims.delete(key);
  }
}

export function handleSizeApiRequest(req: IncomingMessage, res: ServerResponse, deps: SizeApiDeps): boolean {
  return handleServerRoute(req, res, {
    path: PATH_RE,
    label: 'size-api',
    keys: deps.keys,
    read: (owner, id) => overview(deps, owner, id),
    write: (session, owner, id, body) => resize(deps, session, owner, id, body),
  });
}
