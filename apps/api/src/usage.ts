import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { parseId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type SigningKeys } from '@metro-labs/http/workos-token';
import type { ConfigResult } from './launch-config.js';
import type { MetricsLink, UsageRow } from './db/usage.js';
import { associateProfile, AwsError, BOX_ROLE, NODE_TAG, type AwsCredentials } from './aws/ec2.js';
import { getMetricData, listMetrics } from './aws/cloudwatch.js';
import { describeInstanceFacts, type InstanceFacts } from './aws/teardown.js';
import { readUsage, USAGE_RANGES, type Usage, type UsageAws, type UsageRange } from './aws/usage.js';

const PATH_RE = /^\/api\/servers\/([^/]+)\/usage\/?$/;
const ROLE_NOTE_MS = 10 * 60_000;

const OFF = 'This Metro deployment has no AWS account, so it shows no charts.';
const NOT_AVAILABLE =
  'Charts are not available for this server yet. They come from AWS CloudWatch, for servers Metro launched in its own AWS account. A server hosted elsewhere, such as on DigitalOcean, has no charts.';
const WAITING = 'No memory or disk readings yet. Update Metro on this server: it then sends them to CloudWatch every minute.';
const GAVE_ROLE = `Metro gave this server the ${BOX_ROLE} role. Memory and disk show a few minutes after Metro on the server is updated.`;
const NOT_OURS = `Memory and disk need the ${BOX_ROLE} role on this server. Metro did not launch it, so give it the role in the AWS console: Actions, Security, Modify IAM role.`;

export interface RoleAws {
  describe: (credentials: AwsCredentials, region: string, instanceId: string) => Promise<InstanceFacts[]>;
  associate: (credentials: AwsCredentials, region: string, instanceId: string, profile: string) => Promise<void>;
}

export type MetricsAws = UsageAws & RoleAws;

export const LIVE_METRICS: MetricsAws = {
  list: listMetrics,
  data: getMetricData,
  describe: describeInstanceFacts,
  associate: associateProfile,
};

export interface MetricsCore {
  config: () => ConfigResult;
  aws: MetricsAws;
  now: () => number;
}

export interface UsageApiDeps extends MetricsCore {
  lookup: (owner: string, id: string) => Promise<UsageRow>;
  keys: SigningKeys;
}

const roleNotes = new Map<string, { at: number; note: Promise<string> }>();

export function resetUsageState(): void {
  roleNotes.clear();
}

function explain(err: unknown): string {
  if (!(err instanceof AwsError)) return errMsg(err);
  if (!['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation'].includes(err.code)) return err.message;
  return `AWS refused ${err.action || 'a call'}. Add it to the policy of the IAM user metro.`;
}

function roleNoteFor(instance: InstanceFacts | undefined, host: string): string | null {
  if (instance === undefined) return 'AWS does not list the instance of this server, so memory and disk cannot be set up.';
  if (instance.profile !== null) return WAITING;
  return instance.tags[NODE_TAG] === host.split('.')[0] ? null : NOT_OURS;
}

async function giveRole(core: MetricsCore, credentials: AwsCredentials, host: string, link: MetricsLink): Promise<string> {
  try {
    const found = await core.aws.describe(credentials, link.region, link.instanceId);
    const known = roleNoteFor(found.find((i) => i.instanceId === link.instanceId), host);
    if (known !== null) return known;
    await core.aws.associate(credentials, link.region, link.instanceId, BOX_ROLE);
    log.info({ region: link.region, instance: link.instanceId, role: BOX_ROLE }, 'usage: gave the server its role');
    return GAVE_ROLE;
  } catch (err) {
    log.warn({ region: link.region, instance: link.instanceId, err: errMsg(err) }, 'usage: could not give the server its role');
    return `Memory and disk need the ${BOX_ROLE} role on this server, and Metro could not give it: ${explain(err)}`;
  }
}

function agentNote(core: MetricsCore, credentials: AwsCredentials, host: string, link: MetricsLink): Promise<string> {
  const key = `${link.region}/${link.instanceId}`;
  const seen = roleNotes.get(key);
  if (seen !== undefined && core.now() - seen.at < ROLE_NOTE_MS) return seen.note;
  const note = giveRole(core, credentials, host, link);
  roleNotes.set(key, { at: core.now(), note });
  return note;
}

async function view(deps: UsageApiDeps, row: UsageRow, range: UsageRange): Promise<unknown> {
  const config = deps.config();
  if (!config.ok) return { available: false, reason: OFF };
  const link = row.link;
  if (link === null) return { available: false, reason: NOT_AVAILABLE };
  const credentials = config.config.credentials;
  let usage: Usage;
  try {
    usage = await readUsage(deps.aws, credentials, link, range, deps.now());
  } catch (err) {
    throw new ApiError(`Could not read CloudWatch: ${explain(err)}`, 502);
  }
  const note = usage.agent ? null : await agentNote(deps, credentials, row.host, link);
  return { available: true, instanceId: link.instanceId, region: link.region, range, ...usage, note };
}

const rangeOf = (url: string): UsageRange => {
  const asked = new URL(url, 'http://localhost').searchParams.get('range') ?? '1h';
  const range = USAGE_RANGES.find((r) => r === asked);
  if (range === undefined) throw new ApiError('range must be 1h, 24h or 7d', 400);
  return range;
};

async function route(req: IncomingMessage, res: ServerResponse, deps: UsageApiDeps, id: string): Promise<void> {
  try {
    const session = await bearerSession(req, deps.keys);
    const owner = session?.organization ?? null;
    if (session === null || owner === null) {
      sendJson(req, res, 401, { error: 'unauthorized' });
      return;
    }
    const range = rangeOf(req.url ?? '');
    sendJson(req, res, 200, await view(deps, await deps.lookup(owner, id), range));
  } catch (err) {
    apiFailure(req, res, err, 'usage-api');
  }
}

export function handleUsageApiRequest(req: IncomingMessage, res: ServerResponse, deps: UsageApiDeps): boolean {
  const match = PATH_RE.exec((req.url ?? '').split('?')[0] ?? '');
  if (match === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  const id = parseId(match[1] ?? '');
  if (id === null) {
    sendJson(req, res, 404, { error: 'no such server' });
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  route(req, res, deps, id).catch((err: unknown) => {
    apiFailure(req, res, err, 'usage-api');
  });
  return true;
}
