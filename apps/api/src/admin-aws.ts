import { errMsg } from '@metro-labs/core/log';
import type { ConfigResult } from './launch-config.js';
import type { Access } from './aws/access.js';
import { AwsError, type AwsCredentials } from './aws/ec2.js';
import { explain } from './aws/resize.js';
import type { Caller } from './aws/sts.js';
import type { InstanceFacts } from './aws/teardown.js';
import type { MetroServer } from './db/aws.js';

export interface RoleCheckDeps {
  config: () => ConfigResult;
  servers: () => Promise<MetroServer[]>;
  access: Access;
  caller: (credentials: AwsCredentials) => Promise<Caller>;
  describe: (credentials: AwsCredentials, region: string, instanceId: string) => Promise<InstanceFacts[]>;
}

const why = (err: unknown): string => (err instanceof AwsError ? explain(err, '') : errMsg(err));

async function serverCheck(deps: RoleCheckDeps, credentials: AwsCredentials, server: MetroServer): Promise<Record<string, unknown>> {
  const row = { id: server.id, owner: server.owner, name: server.name, region: server.region, instanceId: server.instanceId };
  try {
    const found = (await deps.describe(credentials, server.region, server.instanceId)).find((i) => i.instanceId === server.instanceId);
    return found === undefined ? { ...row, ok: false, error: 'AWS does not list this instance.' } : { ...row, ok: true, state: found.state };
  } catch (err) {
    return { ...row, ok: false, error: why(err) };
  }
}

export async function roleCheck(deps: RoleCheckDeps): Promise<unknown> {
  const config = deps.config();
  if (!config.ok) return { signsInWith: 'none', role: null, check: null };
  const { role, credentials } = config.config;
  const signsInWith = typeof credentials === 'function' ? 'role' : 'key';
  if (role === null) return { signsInWith, role, check: null };
  const roleCredentials = deps.access.metroRole(role);
  let caller: Caller;
  try {
    caller = await deps.caller(roleCredentials);
  } catch (err) {
    return { signsInWith, role, check: { ok: false, error: why(err), servers: [] } };
  }
  const servers = await Promise.all((await deps.servers()).map((server) => serverCheck(deps, roleCredentials, server)));
  return { signsInWith, role, check: { ok: servers.every((s) => s.ok === true), account: caller.account, arn: caller.arn, servers } };
}
