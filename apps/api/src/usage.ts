import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type SigningKeys } from '@metro-labs/http/workos-token';
import type { ConfigResult } from './launch-config.js';
import type { MetricsLink, UsageRow } from './db/usage.js';
import { associateProfile, AwsError, BOX_ROLE, NODE_TAG, type AwsCredentials } from './aws/ec2.js';
import { assumeRole, getMetricData, listMetrics, type RoleCredentials } from './aws/cloudwatch.js';
import { describeInstanceFacts, INSTANCE_ID_RE, type InstanceFacts } from './aws/teardown.js';
import { readUsage, USAGE_RANGES, type Usage, type UsageAws, type UsageRange } from './aws/usage.js';

const PATH_RE = /^\/api\/servers\/([^/]+)\/usage\/?$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const ROLE_MARGIN_MS = 60_000;
const ROLE_NOTE_MS = 10 * 60_000;

const OFF = 'This Metro deployment has no AWS account, so it shows no charts.';
const NOT_AWS =
  'Charts come from AWS CloudWatch, and this server is not linked to an AWS instance. A server hosted elsewhere, such as on DigitalOcean, has no charts.';
const WAITING = 'No memory or disk readings yet. Update Metro on this server: it then sends them to CloudWatch every minute.';
const GAVE_ROLE = `Metro gave this server the ${BOX_ROLE} role. Memory and disk show a few minutes after Metro on the server is updated.`;
const NOT_OURS = `Memory and disk need the ${BOX_ROLE} role on this server. Metro did not launch it, so give it the role in the AWS console: Actions, Security, Modify IAM role.`;
const OTHER_ACCOUNT = `No memory or disk readings yet. Give this server the ${BOX_ROLE} role in its own AWS account, then update Metro on it.`;

export interface RoleAws {
  assume: (credentials: AwsCredentials, roleArn: string) => Promise<RoleCredentials>;
  describe: (credentials: AwsCredentials, region: string, instanceId: string) => Promise<InstanceFacts[]>;
  associate: (credentials: AwsCredentials, region: string, instanceId: string, profile: string) => Promise<void>;
}

export type MetricsAws = UsageAws & RoleAws;

export const LIVE_METRICS: MetricsAws = {
  list: listMetrics,
  data: getMetricData,
  assume: assumeRole,
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

const roles = new Map<string, RoleCredentials>();
const roleNotes = new Map<string, { at: number; note: Promise<string> }>();

export function resetUsageState(): void {
  roles.clear();
  roleNotes.clear();
}

function explain(err: unknown, link: MetricsLink): string {
  if (!(err instanceof AwsError)) return errMsg(err);
  if (!['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation'].includes(err.code)) return err.message;
  const where = link.roleArn === null ? 'the policy of the IAM user metro' : `the role ${link.roleArn}`;
  return `AWS refused ${err.action || 'a call'}. Add it to ${where}.`;
}

async function credentialsFor(core: MetricsCore, base: AwsCredentials, link: MetricsLink): Promise<AwsCredentials> {
  if (link.roleArn === null) return base;
  const cached = roles.get(link.roleArn);
  if (cached !== undefined && cached.expiresAt - ROLE_MARGIN_MS > core.now()) return cached;
  try {
    const fresh = await core.aws.assume(base, link.roleArn);
    roles.set(link.roleArn, fresh);
    return fresh;
  } catch (err) {
    throw new ApiError(
      `Metro could not take the role ${link.roleArn}: ${errMsg(err)} Its trust policy must name Metro's AWS account, and the IAM user metro may need sts:AssumeRole on it.`,
      502,
    );
  }
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
    return `Memory and disk need the ${BOX_ROLE} role on this server, and Metro could not give it: ${explain(err, link)}`;
  }
}

function agentNote(core: MetricsCore, credentials: AwsCredentials, host: string, link: MetricsLink): Promise<string> {
  if (link.roleArn !== null) return Promise.resolve(OTHER_ACCOUNT);
  const key = `${link.region}/${link.instanceId}`;
  const seen = roleNotes.get(key);
  if (seen !== undefined && core.now() - seen.at < ROLE_NOTE_MS) return seen.note;
  const note = giveRole(core, credentials, host, link);
  roleNotes.set(key, { at: core.now(), note });
  return note;
}

export async function usageOf(core: MetricsCore, link: MetricsLink, range: UsageRange): Promise<{ credentials: AwsCredentials; usage: Usage }> {
  const config = core.config();
  if (!config.ok) throw new ApiError(OFF, 400);
  const credentials = await credentialsFor(core, config.config.credentials, link);
  try {
    return { credentials, usage: await readUsage(core.aws, credentials, link, range, core.now()) };
  } catch (err) {
    throw new ApiError(`Could not read CloudWatch: ${explain(err, link)}`, 502);
  }
}

async function view(deps: UsageApiDeps, row: UsageRow, range: UsageRange): Promise<unknown> {
  if (!deps.config().ok) return { available: false, reason: OFF };
  const link = row.link;
  if (link === null) return { available: false, reason: NOT_AWS };
  const { credentials, usage } = await usageOf(deps, link, range);
  const note = usage.agent ? null : await agentNote(deps, credentials, row.host, link);
  return { available: true, instanceId: link.instanceId, region: link.region, range, ...usage, note };
}

const field = (body: unknown, name: string): string => (isRecord(body) && typeof body[name] === 'string' ? body[name].trim() : '');

export function parseLink(body: unknown): MetricsLink | null {
  const instanceId = field(body, 'instanceId');
  if (instanceId === '') return null;
  if (!INSTANCE_ID_RE.test(instanceId)) throw new ApiError('the instance id looks like i-0123456789abcdef0', 400);
  const region = field(body, 'region');
  if (!REGION_RE.test(region)) throw new ApiError('the region looks like us-east-1 or eu-central-2', 400);
  const roleArn = field(body, 'roleArn');
  if (roleArn !== '' && !ROLE_ARN_RE.test(roleArn)) throw new ApiError('the role ARN looks like arn:aws:iam::123456789012:role/metro-cloudwatch-read', 400);
  return { instanceId, region, roleArn: roleArn === '' ? null : roleArn };
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
