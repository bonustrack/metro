import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { signedIdentity } from '@metro-labs/http/signed-identity';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { mayLaunch, type ConfigResult, type LaunchConfig } from './launch-config.js';
import type { AwsCredentials, InstanceState } from './aws/ec2.js';
import type { BootView, Launched, LaunchInput } from './aws/launch.js';
import type { LaunchRecord, ServerLaunch } from './db/servers.js';
import type { ServerEntry } from './server-types.js';

const PREFIX = '/api/launch';
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const NAME_MAX = 40;
const IN_FLIGHT_MS = 60_000;
const REGIONS_TTL_MS = 60 * 60_000;

export interface LaunchApiDeps {
  config: () => ConfigResult;
  launch: (input: LaunchInput) => Promise<Launched>;
  regions: (credentials: AwsCredentials) => Promise<string[]>;
  state: (credentials: AwsCredentials, region: string, instanceId: string) => Promise<InstanceState>;
  boot: (credentials: AwsCredentials, region: string, instanceId: string) => Promise<BootView>;
  record: (subject: string, launch: LaunchRecord) => Promise<ServerEntry>;
  count: (subject: string) => Promise<number>;
  lookup: (subject: string, id: string) => Promise<ServerLaunch>;
  now: () => number;
}

type Target =
  | { kind: 'index' }
  | { kind: 'server'; id: string }
  | { kind: 'boot'; id: string }
  | { kind: 'unknown' }
  | null;

export function launchTarget(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const id = parseId(segments[0] ?? '');
  if (id === null || segments.length > 2) return { kind: 'unknown' };
  if (segments.length === 1) return { kind: 'server', id };
  return segments[1] === 'boot' ? { kind: 'boot', id } : { kind: 'unknown' };
}

const ALLOWED: Record<'index' | 'server' | 'boot', string[]> = {
  index: ['GET', 'POST'],
  server: ['GET'],
  boot: ['GET'],
};

let regionCache: { at: number; regions: string[] } | null = null;
const inFlight = new Map<string, number>();

export function resetLaunchState(): void {
  regionCache = null;
  inFlight.clear();
}

async function enabledRegions(deps: LaunchApiDeps, config: LaunchConfig): Promise<string[]> {
  const now = deps.now();
  if (regionCache !== null && now - regionCache.at < REGIONS_TTL_MS) return regionCache.regions;
  try {
    const regions = await deps.regions(config.credentials);
    regionCache = { at: now, regions };
    return regions;
  } catch (err) {
    log.warn({ err: String(err) }, 'launch: could not list the regions this account has enabled');
    return [];
  }
}

function allowed(deps: LaunchApiDeps, subject: string): LaunchConfig {
  const result = deps.config();
  if (!result.ok) throw new ApiError('metro does not issue servers on this deployment', 404);
  if (!mayLaunch(result.config, subject))
    throw new ApiError('this wallet may not have metro issue servers', 403);
  return result.config;
}

async function overview(deps: LaunchApiDeps, subject: string): Promise<unknown> {
  const result = deps.config();
  if (!result.ok || !mayLaunch(result.config, subject)) return { enabled: false };
  const used = await deps.count(subject);
  return {
    enabled: true,
    region: result.config.region,
    regions: await enabledRegions(deps, result.config),
    remaining: Math.max(0, result.config.perOwner - used),
  };
}

function nameOf(body: unknown): string {
  const raw = isRecord(body) && typeof body.name === 'string' ? body.name.trim() : '';
  if (raw === '') throw new ApiError('the server needs a name', 400);
  if (raw.length > NAME_MAX) throw new ApiError(`a server name is at most ${String(NAME_MAX)} characters`, 400);
  return raw;
}

function regionOf(body: unknown, config: LaunchConfig): string {
  const raw = isRecord(body) && typeof body.region === 'string' ? body.region.trim() : '';
  const region = raw === '' ? config.region : raw;
  if (!REGION_RE.test(region)) throw new ApiError('the region is an AWS region name, as in eu-west-1', 400);
  return region;
}

function holdDuplicate(deps: LaunchApiDeps, subject: string): void {
  const now = deps.now();
  for (const [who, at] of inFlight) if (now - at > IN_FLIGHT_MS) inFlight.delete(who);
  if (inFlight.has(subject))
    throw new ApiError('a launch for this wallet is already running; wait for it to answer', 409);
  inFlight.set(subject, now);
}

async function issue(deps: LaunchApiDeps, subject: string, body: unknown): Promise<unknown> {
  const config = allowed(deps, subject);
  const name = nameOf(body);
  const region = regionOf(body, config);
  if ((await deps.count(subject)) >= config.perOwner)
    throw new ApiError(`this wallet already holds ${String(config.perOwner)} servers metro issued`, 429);
  holdDuplicate(deps, subject);
  try {
    const launched = await deps.launch({
      name,
      region,
      owner: subject,
      tailnet: config.tailnet,
      authKey: config.authKey,
      credentials: config.credentials,
    });
    const server = await deps.record(subject, {
      host: launched.host,
      name,
      instanceId: launched.instanceId,
      region: launched.region,
    });
    log.info(
      { host: launched.host, region: launched.region, zone: launched.zone, instance: launched.instanceId },
      'launch: metro issued a server',
    );
    return { server, host: launched.host, node: launched.node, region: launched.region, zone: launched.zone };
  } finally {
    inFlight.delete(subject);
  }
}

async function answer(
  req: IncomingMessage,
  deps: LaunchApiDeps,
  subject: string,
  tgt: Exclude<Target, { kind: 'unknown' } | null>,
): Promise<unknown> {
  if (tgt.kind === 'index')
    return req.method === 'GET' ? overview(deps, subject) : issue(deps, subject, await readJsonBody(req));
  const config = allowed(deps, subject);
  const launch = await deps.lookup(subject, tgt.id);
  if (tgt.kind === 'boot') return deps.boot(config.credentials, launch.region, launch.instanceId);
  return deps.state(config.credentials, launch.region, launch.instanceId);
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LaunchApiDeps,
  tgt: Exclude<Target, { kind: 'unknown' } | null>,
): Promise<void> {
  try {
    const subject = await signedIdentity(req);
    if (subject === null) {
      sendJson(req, res, 401, { error: 'unauthorized' });
      return;
    }
    sendJson(req, res, 200, await answer(req, deps, subject, tgt));
  } catch (err) {
    apiFailure(req, res, err, 'launch-api');
  }
}

export function handleLaunchApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LaunchApiDeps,
): boolean {
  const tgt = launchTarget((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such launch' });
    return true;
  }
  if (!ALLOWED[tgt.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  route(req, res, deps, tgt).catch((err: unknown) => {
    apiFailure(req, res, err, 'launch-api');
  });
  return true;
}
