import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { apiFailure, cors, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type SigningKeys } from '@metro-labs/http/workos-token';
import type { AwsCredentials } from './aws/ec2.js';
import type { LinkedRow } from './db/usage.js';
import { readLatest, type Latest } from './aws/latest.js';
import type { MetricsCore } from './usage.js';

const PATH_RE = /^\/api\/servers\/usage\/?$/;
const CACHE_MS = 60_000;

export interface LatestApiDeps extends MetricsCore {
  rows: (owner: string) => Promise<LinkedRow[]>;
  keys: SigningKeys;
}

type Answer = Record<string, Latest>;

const cache = new Map<string, { at: number; answer: Promise<Answer> }>();

export function resetLatestCache(): void {
  cache.clear();
}

const NONE: Latest = { cpu: null, memory: null, disk: null };

interface Group {
  region: string;
  rows: { id: string; instanceId: string }[];
}

function groupsOf(rows: LinkedRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const { id, link } of rows) {
    if (link === null) continue;
    const group = groups.get(link.region) ?? { region: link.region, rows: [] };
    group.rows.push({ id, instanceId: link.instanceId });
    groups.set(link.region, group);
  }
  return [...groups.values()];
}

async function readGroup(core: MetricsCore, credentials: AwsCredentials, group: Group): Promise<[string, Latest][]> {
  try {
    const found = await readLatest(core.aws, credentials, group.region, group.rows.map((r) => r.instanceId), core.now());
    return group.rows.map((r) => [r.id, found.get(r.instanceId) ?? NONE]);
  } catch (err) {
    log.warn({ region: group.region, servers: group.rows.length, err: errMsg(err) }, 'usage: could not read the latest usage');
    return group.rows.map((r) => [r.id, NONE]);
  }
}

async function latestOf(deps: LatestApiDeps, owner: string): Promise<Answer> {
  const config = deps.config();
  if (!config.ok) return {};
  const groups = groupsOf(await deps.rows(owner));
  const read = await Promise.all(groups.map((group) => readGroup(deps, config.config.credentials, group)));
  return Object.fromEntries(read.flat());
}

function cached(deps: LatestApiDeps, owner: string): Promise<Answer> {
  const now = deps.now();
  for (const [key, entry] of cache) if (now - entry.at >= CACHE_MS) cache.delete(key);
  const hit = cache.get(owner);
  if (hit !== undefined) return hit.answer;
  const answer = latestOf(deps, owner);
  cache.set(owner, { at: now, answer });
  answer.catch(() => {
    if (cache.get(owner)?.answer === answer) cache.delete(owner);
  });
  return answer;
}

async function route(req: IncomingMessage, res: ServerResponse, deps: LatestApiDeps): Promise<void> {
  try {
    const session = await bearerSession(req, deps.keys);
    const owner = session?.organization ?? null;
    if (session === null || owner === null) {
      sendJson(req, res, 401, { error: 'unauthorized' });
      return;
    }
    sendJson(req, res, 200, { servers: await cached(deps, owner) });
  } catch (err) {
    apiFailure(req, res, err, 'usage-api');
  }
}

export function handleLatestApiRequest(req: IncomingMessage, res: ServerResponse, deps: LatestApiDeps): boolean {
  if (!PATH_RE.test((req.url ?? '').split('?')[0] ?? '')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  route(req, res, deps).catch((err: unknown) => {
    apiFailure(req, res, err, 'usage-api');
  });
  return true;
}
