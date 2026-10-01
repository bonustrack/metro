import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import type { Session, SigningKeys } from '@metro-labs/http/workos-token';
import type { ConfigResult } from './launch-config.js';
import type { DeletionRow } from './db/servers.js';
import type { AwsCredentials } from './aws/ec2.js';
import type { Ec2Target } from './aws/resize.js';
import {
  applying,
  growRunning,
  GrowRefused,
  maxGibOf,
  readRootDisk,
  runGrow,
  sizesFor,
  startGrow,
  type GrowAws,
  type GrowJob,
  type Owner,
  type RootDisk,
} from './aws/grow.js';
import { fromAws } from './size.js';
import { handleServerRoute } from './server-route.js';

const PATH_RE = /^\/api\/servers\/([^/]+)\/storage\/?$/;
const JOB_SHOWN_MS = 60 * 60_000;
const PRICED_TTL_MS = 24 * 60 * 60_000;
const UNPRICED_TTL_MS = 10 * 60_000;
const OFF = 'This Metro deployment has no AWS account, so it cannot grow the disk of a server.';
const NOT_LAUNCHED = 'Metro did not launch this server on AWS, so it cannot grow its disk.';

export interface StorageApiDeps {
  config: () => ConfigResult;
  lookup: (owner: string, id: string) => Promise<DeletionRow>;
  aws: GrowAws;
  price: (credentials: AwsCredentials, region: string, volumeType: string) => Promise<number | null>;
  resizing: (region: string, instanceId: string) => boolean;
  keys: SigningKeys;
}

interface Resolved {
  target: Ec2Target;
  owner: Owner;
}

const jobs = new Map<string, GrowJob>();
const claims = new Set<string>();
const prices = new Map<string, { at: number; usd: number | null }>();

export function resetStorageState(): void {
  jobs.clear();
  claims.clear();
  prices.clear();
}

const keyOf = (target: Pick<Ec2Target, 'region' | 'instanceId'>): string => `${target.region}/${target.instanceId}`;

export const growing = (region: string, instanceId: string): boolean => {
  const key = keyOf({ region, instanceId });
  return claims.has(key) || growRunning(jobs.get(key));
};

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await fromAws(work);
  } catch (err) {
    if (err instanceof GrowRefused) throw new ApiError(err.message, 409);
    throw err;
  }
}

async function resolve(deps: StorageApiDeps, owner: string, id: string): Promise<Resolved | string> {
  const row = await deps.lookup(owner, id);
  const config = deps.config();
  if (!config.ok) return OFF;
  if (row.instanceId === null || row.region === null) return NOT_LAUNCHED;
  return {
    target: { credentials: config.config.credentials, region: row.region, instanceId: row.instanceId },
    owner: { agentId: row.id, host: row.host },
  };
}

async function priceOf(deps: StorageApiDeps, target: Ec2Target, type: string): Promise<number | null> {
  const key = `${target.region}/${type}`;
  const now = deps.aws.now();
  const held = prices.get(key);
  if (held !== undefined && now - held.at < (held.usd === null ? UNPRICED_TTL_MS : PRICED_TTL_MS)) return held.usd;
  const usd = await deps.price(target.credentials, target.region, type).catch((err: unknown) => {
    log.warn({ region: target.region, type, err: errMsg(err) }, 'storage: the AWS price list did not answer, so the page shows no price');
    return null;
  });
  prices.set(key, { at: now, usd });
  return usd;
}

function shownJob(target: Ec2Target, now: number): GrowJob | null {
  const job = jobs.get(keyOf(target));
  if (job === undefined) return null;
  return growRunning(job) || now - Date.parse(job.finishedAt ?? '') < JOB_SHOWN_MS ? job : null;
}

async function viewOf(deps: StorageApiDeps, target: Ec2Target, disk: RootDisk): Promise<unknown> {
  const { modification } = disk;
  return {
    growable: true,
    region: target.region,
    instanceId: target.instanceId,
    state: disk.state,
    volumeId: disk.volumeId,
    sizeGib: disk.sizeGib,
    type: disk.type,
    maxGib: maxGibOf(disk.type),
    gbMonthUsd: await priceOf(deps, target, disk.type),
    options: sizesFor(disk),
    modification: modification === null ? null : { state: modification.state, progress: modification.progress, targetGib: modification.targetGib },
    job: shownJob(target, deps.aws.now()),
  };
}

async function overview(deps: StorageApiDeps, owner: string, id: string): Promise<unknown> {
  const resolved = await resolve(deps, owner, id);
  if (typeof resolved === 'string') return { growable: false, reason: resolved };
  const disk = await guarded(() => readRootDisk(deps.aws, resolved.target, resolved.owner));
  return viewOf(deps, resolved.target, disk);
}

function sizeOf(body: unknown): number {
  const size = isRecord(body) ? body.sizeGib : undefined;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) throw new ApiError('the size is a whole number of GiB, as in 32', 400);
  return size;
}

function checkRequest(disk: RootDisk, sizeGib: number): void {
  if (disk.state !== 'running' && disk.state !== 'stopped') throw new ApiError(`the server is ${disk.state} in AWS. Try again once it is running or stopped`, 409);
  if (applying(disk.modification)) throw new ApiError('AWS is still applying the last change to this disk. Try again once it is done', 409);
  if (sizeGib <= disk.sizeGib) throw new ApiError(`the disk is already ${String(disk.sizeGib)} GiB, and a disk can only grow`, 400);
  if (!sizesFor(disk).includes(sizeGib)) throw new ApiError(`${String(sizeGib)} GiB is not one of the sizes offered for this disk`, 400);
}

function follow(deps: StorageApiDeps, target: Ec2Target, volumeId: string, job: GrowJob): void {
  jobs.set(keyOf(target), job);
  log.info({ region: target.region, instance: target.instanceId, volume: volumeId, from: job.from, to: job.to }, 'storage: disk growing');
  runGrow(deps.aws, target, volumeId, job)
    .then(() => {
      log.info({ instance: target.instanceId, volume: volumeId, to: job.to, phase: job.phase, error: job.error }, 'storage: disk grow finished');
    })
    .catch((err: unknown) => {
      job.phase = 'failed';
      job.error = `Following the disk stopped unexpectedly: ${errMsg(err)}`;
      job.finishedAt = new Date(deps.aws.now()).toISOString();
      log.warn({ instance: target.instanceId, err: errMsg(err) }, 'storage: disk grow crashed');
    });
}

async function grow(deps: StorageApiDeps, session: Session, owner: string, id: string, body: unknown): Promise<unknown> {
  if (session.role !== 'admin') throw new ApiError('growing the disk needs the admin role in your organization', 403);
  const sizeGib = sizeOf(body);
  const resolved = await resolve(deps, owner, id);
  if (typeof resolved === 'string') throw new ApiError(resolved, 400);
  const { target } = resolved;
  const key = keyOf(target);
  if (growing(target.region, target.instanceId)) throw new ApiError('this disk is already growing. Wait for it to finish', 409);
  if (deps.resizing(target.region, target.instanceId)) throw new ApiError('this server is changing size. Wait for it to finish', 409);
  claims.add(key);
  try {
    const disk = await guarded(() => readRootDisk(deps.aws, target, resolved.owner));
    checkRequest(disk, sizeGib);
    const job = await fromAws(() => startGrow(deps.aws, target, disk, sizeGib));
    follow(deps, target, disk.volumeId, job);
    return await viewOf(deps, target, disk);
  } finally {
    claims.delete(key);
  }
}

export function handleStorageApiRequest(req: IncomingMessage, res: ServerResponse, deps: StorageApiDeps): boolean {
  return handleServerRoute(req, res, {
    path: PATH_RE,
    label: 'storage-api',
    keys: deps.keys,
    read: (owner, id) => overview(deps, owner, id),
    write: (session, owner, id, body) => grow(deps, session, owner, id, body),
  });
}
