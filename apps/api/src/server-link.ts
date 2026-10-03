import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import type { Session, SigningKeys } from '@metro-labs/http/workos-token';
import type { ConfigResult } from './launch-config.js';
import type { DeletionRow } from './db/servers.js';
import type { AwsStore } from './db/aws.js';
import type { Access } from './aws/access.js';
import { REGION_RE, type AwsCredentials } from './aws/ec2.js';
import { INSTANCE_ID_RE, nodeIn, tagMismatch, type InstanceFacts } from './aws/teardown.js';
import { fromAws } from './size.js';
import { handleServerRoute } from './server-route.js';

const PATH_RE = /^\/api\/servers\/([^/]+)\/link\/?$/;
const OFF = 'This Metro deployment has no AWS account, so it cannot link a server to one.';

export interface LinkAws {
  describe: (credentials: AwsCredentials, region: string, instanceId: string) => Promise<InstanceFacts[]>;
  tag: (credentials: AwsCredentials, region: string, instanceId: string, node: string, agentId: string) => Promise<void>;
}

export interface ServerLinkDeps {
  config: () => ConfigResult;
  lookup: (owner: string, id: string) => Promise<DeletionRow>;
  store: AwsStore;
  access: Access;
  aws: LinkAws;
  keys: SigningKeys;
}

interface Wanted {
  connection: string;
  region: string;
  instanceId: string;
}

async function view(deps: ServerLinkDeps, owner: string, id: string): Promise<unknown> {
  const row = await deps.lookup(owner, id);
  if (row.instanceId !== null && row.account === null) return { mode: 'metro', region: row.region, instanceId: row.instanceId };
  const connections = await deps.store.list(owner);
  if (row.account === null) return { mode: 'none', connections: connections.length };
  const { connection } = row.account;
  const accountId = connections.find((c) => c.id === connection)?.accountId ?? null;
  return { mode: 'linked', connection, accountId, region: row.region, instanceId: row.instanceId };
}

function wantedOf(body: unknown): Wanted {
  const field = (name: string): string => (isRecord(body) && typeof body[name] === 'string' ? body[name].trim() : '');
  const wanted = { connection: field('connection'), region: field('region'), instanceId: field('instanceId') };
  if (wanted.connection === '' || !REGION_RE.test(wanted.region) || !INSTANCE_ID_RE.test(wanted.instanceId))
    throw new ApiError('send the AWS account, the region and the instance id of the server', 400);
  return wanted;
}

const LAUNCHED = 'Metro launched this server in its own AWS account, so it is linked already';

function linkable(row: DeletionRow): string {
  if (row.instanceId !== null && row.account === null) throw new ApiError(LAUNCHED, 409);
  const node = nodeIn(row.host);
  if (node === null) throw new ApiError('Metro links only a server whose address starts with its node name, as in metro-abc123', 400);
  return node;
}

async function link(deps: ServerLinkDeps, owner: string, row: DeletionRow, wanted: Wanted): Promise<void> {
  const config = deps.config();
  if (!config.ok) throw new ApiError(OFF, 400);
  const node = linkable(row);
  const [connection, externalId, links] = await Promise.all([deps.store.find(owner, wanted.connection), deps.store.externalId(owner), deps.store.linked(owner)]);
  if (connection === null || externalId === null) throw new ApiError('no such AWS account in this organization', 404);
  const other = links.find((l) => l.connection === connection.id && l.instanceId === wanted.instanceId && l.agentId !== row.id);
  if (other !== undefined) throw new ApiError('another agent of this organization is linked to that server', 409);
  const credentials = deps.access.reach(config.config, { connection: connection.id, roleArn: connection.roleArn, externalId });
  const found = (await fromAws(() => deps.aws.describe(credentials, wanted.region, wanted.instanceId))).find((i) => i.instanceId === wanted.instanceId);
  if (found === undefined) throw new ApiError(`AWS account ${connection.accountId} has no server ${wanted.instanceId} in ${wanted.region}`, 404);
  const mismatch = tagMismatch(found.tags, node, row.id, false);
  if (mismatch !== null) throw new ApiError(`That server ${mismatch}`, 409);
  await fromAws(() => deps.aws.tag(credentials, wanted.region, wanted.instanceId, node, row.id));
  if (!(await deps.store.link(owner, row.id, wanted))) throw new ApiError(LAUNCHED, 409);
  log.info({ owner, agent: row.id, connection: connection.id, accountId: connection.accountId, region: wanted.region, instance: wanted.instanceId }, 'aws: a server was linked to its AWS instance');
}

async function change(deps: ServerLinkDeps, session: Session, owner: string, id: string, body: unknown): Promise<unknown> {
  if (session.role !== 'admin') throw new ApiError('linking a server needs the admin role in your organization', 403);
  const row = await deps.lookup(owner, id);
  if (isRecord(body) && body.unlink === true) {
    if (!(await deps.store.unlink(owner, row.id))) throw new ApiError('this server is not linked to a connected AWS account', 400);
    log.info({ owner, agent: row.id }, 'aws: a server was unlinked from its AWS instance');
  } else await link(deps, owner, row, wantedOf(body));
  return view(deps, owner, id);
}

export function handleServerLinkRequest(req: IncomingMessage, res: ServerResponse, deps: ServerLinkDeps): boolean {
  return handleServerRoute(req, res, {
    path: PATH_RE,
    label: 'link-api',
    keys: deps.keys,
    read: (owner, id) => view(deps, owner, id),
    write: (session, owner, id, body) => change(deps, session, owner, id, body),
  });
}
