import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { newId, parseId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type Session, type SigningKeys } from '@metro-labs/http/workos-token';
import type { ConfigResult, LaunchConfig } from './launch-config.js';
import type { Access, AwsAccount } from './aws/access.js';
import { AWS_REFUSED, AwsError, type AwsCredentials } from './aws/ec2.js';
import { accountOfRole, ROLE_ARN_RE, type Caller } from './aws/sts.js';
import { quickCreateUrl, type Templates } from './aws/templates.js';
import type { InstanceFacts } from './aws/teardown.js';
import type { AwsStore, Connection } from './db/aws.js';
import { explain } from './aws/resize.js';

const PREFIX = '/api/aws';
const REGIONS_TTL_MS = 60 * 60_000;
const NOT_OURS = 'This Metro deployment has no AWS account, so it cannot connect another one.';
const NO_ROLE = 'Metro has no AWS role of its own yet, so it cannot connect another AWS account. The operator sets it up once (docs/ISSUING-SERVERS.md).';
const NO_BUCKET = 'Metro has no bucket for its AWS template yet (METRO_AWS_TEMPLATES), so it cannot make the link.';

export interface ConnectionAws {
  caller: (credentials: AwsCredentials) => Promise<Caller>;
  regions: (credentials: AwsCredentials) => Promise<string[]>;
  instances: (credentials: AwsCredentials, region: string) => Promise<InstanceFacts[]>;
  publish: (credentials: AwsCredentials, templates: Templates) => Promise<string>;
}

export interface AwsConnectionsDeps {
  config: () => ConfigResult;
  templates: () => Templates | null;
  store: AwsStore;
  access: Access;
  aws: ConnectionAws;
  externalId: () => string;
  now: () => number;
  keys: SigningKeys;
}

interface Ready {
  config: LaunchConfig;
  role: string;
  templates: Templates;
}

type Readiness = { ready: true; at: Ready } | { ready: false; reason: string };

export interface FoundInstance {
  connection: string;
  accountId: string;
  region: string;
  instanceId: string;
  name: string | null;
  state: string;
  type: string;
  node: string | null;
  agentId: string | null;
}

const regionCache = new Map<string, { at: number; regions: string[] }>();

export function resetConnectionsState(): void {
  regionCache.clear();
}

function readiness(deps: AwsConnectionsDeps): Readiness {
  const config = deps.config();
  if (!config.ok) return { ready: false, reason: NOT_OURS };
  const { role } = config.config;
  if (role === null) return { ready: false, reason: NO_ROLE };
  const templates = deps.templates();
  if (templates === null) return { ready: false, reason: NO_BUCKET };
  return { ready: true, at: { config: config.config, role, templates } };
}

function ready(deps: AwsConnectionsDeps): Ready {
  const state = readiness(deps);
  if (!state.ready) throw new ApiError(state.reason, 400);
  return state.at;
}

function admin(session: Session): void {
  if (session.role !== 'admin') throw new ApiError('connecting an AWS account needs the admin role in your organization', 403);
}

async function aws<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AwsError) throw new ApiError(explain(err, ''), AWS_REFUSED);
    throw err;
  }
}

async function overview(deps: AwsConnectionsDeps, owner: string): Promise<unknown> {
  const state = readiness(deps);
  const config = deps.config();
  return {
    ready: state.ready,
    reason: state.ready ? null : state.reason,
    metroRole: config.ok ? config.config.role : null,
    externalId: await deps.store.externalId(owner),
    connections: await deps.store.list(owner),
  };
}

async function link(deps: AwsConnectionsDeps, owner: string): Promise<unknown> {
  const at = ready(deps);
  const externalId = await deps.store.ensureExternalId(owner, deps.externalId());
  const templateUrl = await aws(() => deps.aws.publish(deps.access.metroRole(at.role), at.templates));
  return { url: quickCreateUrl(templateUrl, { ExternalId: externalId, MetroRoleArn: at.role }), externalId, templateUrl };
}

const roleOf = (body: unknown): string => (isRecord(body) && typeof body.roleArn === 'string' ? body.roleArn.trim() : '');

async function connect(deps: AwsConnectionsDeps, owner: string, body: unknown): Promise<unknown> {
  const at = ready(deps);
  const roleArn = roleOf(body);
  const accountId = accountOfRole(roleArn);
  if (!ROLE_ARN_RE.test(roleArn) || accountId === null) throw new ApiError('paste the RoleArn output of the stack, as in arn:aws:iam::123456789012:role/metro-access', 400);
  const externalId = await deps.store.externalId(owner);
  if (externalId === null) throw new ApiError('open the Connect AWS link first: it gives your organization its external id', 400);
  const id = newId();
  const credentials = deps.access.reach(at.config, { connection: id, roleArn, externalId });
  let regions: string[];
  try {
    const caller = await deps.aws.caller(credentials);
    if (caller.account !== accountId) throw new AwsError('WrongAccount', `the role answered from AWS account ${caller.account}, not ${accountId}.`);
    regions = await deps.aws.regions(credentials);
  } catch (err) {
    log.warn({ owner, roleArn, err: errMsg(err) }, 'aws: a connection was refused');
    throw new ApiError(`Metro could not use ${roleArn}: ${errMsg(err)} Check that the stack finished and that you pasted its RoleArn output.`, 400);
  }
  const connection = await deps.store.add(owner, { id, accountId, roleArn, addedAt: new Date(deps.now()).toISOString() });
  regionCache.set(id, { at: deps.now(), regions });
  log.info({ owner, connection: id, accountId, regions: regions.length }, 'aws: an AWS account was connected');
  return { connection, regions: regions.length };
}

async function disconnect(deps: AwsConnectionsDeps, owner: string, id: string): Promise<unknown> {
  const unlinked = await deps.store.remove(owner, id);
  regionCache.delete(id);
  log.info({ owner, connection: id, unlinked }, 'aws: an AWS account was disconnected');
  return { removed: true, unlinked };
}

async function regionsOf(deps: AwsConnectionsDeps, connection: string, credentials: AwsCredentials): Promise<string[]> {
  const held = regionCache.get(connection);
  if (held !== undefined && deps.now() - held.at < REGIONS_TTL_MS) return held.regions;
  const regions = await deps.aws.regions(credentials);
  regionCache.set(connection, { at: deps.now(), regions });
  return regions;
}

async function instancesOf(deps: AwsConnectionsDeps, config: LaunchConfig, connection: Connection, externalId: string, linked: Map<string, string>): Promise<FoundInstance[]> {
  const account: AwsAccount = { connection: connection.id, roleArn: connection.roleArn, externalId };
  const credentials = deps.access.reach(config, account);
  const regions = await regionsOf(deps, connection.id, credentials);
  const found = await Promise.all(regions.map(async (region) => (await deps.aws.instances(credentials, region)).map((i) => ({ region, i }))));
  return found.flat().map(({ region, i }) => ({
    connection: connection.id,
    accountId: connection.accountId,
    region,
    instanceId: i.instanceId,
    name: i.tags.Name ?? null,
    state: i.state,
    type: i.type,
    node: i.tags.metro ?? null,
    agentId: linked.get(`${connection.id}/${i.instanceId}`) ?? null,
  }));
}

async function instances(deps: AwsConnectionsDeps, owner: string): Promise<unknown> {
  const config = deps.config();
  if (!config.ok) return { instances: [], errors: [] };
  const [connections, externalId, links] = await Promise.all([deps.store.list(owner), deps.store.externalId(owner), deps.store.linked(owner)]);
  if (externalId === null) return { instances: [], errors: [] };
  const linked = new Map(links.map((l) => [`${l.connection}/${l.instanceId}`, l.agentId]));
  const read = await Promise.all(
    connections.map(async (c) => {
      try {
        return { instances: await instancesOf(deps, config.config, c, externalId, linked), error: null };
      } catch (err) {
        return { instances: [], error: { connection: c.id, accountId: c.accountId, error: err instanceof AwsError ? explain(err, '') : errMsg(err) } };
      }
    }),
  );
  return { instances: read.flatMap((r) => r.instances), errors: read.flatMap((r) => (r.error === null ? [] : [r.error])) };
}

type Target = { kind: 'index' } | { kind: 'link' } | { kind: 'connections' } | { kind: 'connection'; id: string } | { kind: 'instances' };

const ALLOWED: Record<Target['kind'], string> = { index: 'GET', link: 'POST', connections: 'POST', connection: 'DELETE', instances: 'GET' };

const NAMED: Record<string, Target> = { link: { kind: 'link' }, connections: { kind: 'connections' }, instances: { kind: 'instances' } };

function subTarget(segments: string[]): Target | 'unknown' {
  const [first = '', second] = segments;
  if (segments.length === 1) return NAMED[first] ?? 'unknown';
  const id = parseId(second ?? '');
  return segments.length === 2 && first === 'connections' && id !== null ? { kind: 'connection', id } : 'unknown';
}

function targetOf(path: string): Target | 'unknown' | null {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  return subTarget(path.slice(PREFIX.length + 1).split('/').filter(Boolean));
}

async function answer(req: IncomingMessage, deps: AwsConnectionsDeps, session: Session, owner: string, target: Target): Promise<unknown> {
  if (target.kind === 'index') return overview(deps, owner);
  if (target.kind === 'instances') return instances(deps, owner);
  admin(session);
  if (target.kind === 'link') return link(deps, owner);
  if (target.kind === 'connections') return connect(deps, owner, await readJsonBody(req));
  return disconnect(deps, owner, target.id);
}

async function route(req: IncomingMessage, res: ServerResponse, deps: AwsConnectionsDeps, target: Target): Promise<void> {
  try {
    const session = await bearerSession(req, deps.keys);
    const owner = session?.organization ?? null;
    if (session === null || owner === null) {
      sendJson(req, res, 401, { error: 'unauthorized' });
      return;
    }
    sendJson(req, res, 200, await answer(req, deps, session, owner, target));
  } catch (err) {
    apiFailure(req, res, err, 'aws-api');
  }
}

export function handleAwsConnectionsRequest(req: IncomingMessage, res: ServerResponse, deps: AwsConnectionsDeps): boolean {
  const target = targetOf((req.url ?? '').split('?')[0] ?? '');
  if (target === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (target === 'unknown') {
    sendJson(req, res, 404, { error: 'not found' });
    return true;
  }
  if (req.method !== ALLOWED[target.kind]) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  route(req, res, deps, target).catch((err: unknown) => {
    apiFailure(req, res, err, 'aws-api');
  });
  return true;
}
