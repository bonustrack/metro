import { errMsg, log } from '@metro-labs/core/log';
import { AwsError, type AwsCredentials } from './ec2.js';
import { assumeRole, assumeRoleWithWebIdentity, type RoleKeys } from './sts.js';
import { flyOidcToken, STS_AUDIENCE } from './fly-oidc.js';

export const REFRESH_MARGIN_MS = 5 * 60_000;
const NO_ROLE = 'Metro has no AWS role of its own yet (METRO_AWS_ROLE_ARN), so it cannot reach another AWS account.';

export interface AwsAccount {
  connection: string;
  roleArn: string;
  externalId: string;
}

export interface MetroAws {
  credentials: AwsCredentials;
  role: string | null;
}

interface Held {
  pending: Promise<RoleKeys>;
  keys: RoleKeys | null;
}

export class RoleCache {
  private readonly held = new Map<string, Held>();

  constructor(private readonly now: () => number) {}

  get(key: string, mint: () => Promise<RoleKeys>): Promise<RoleKeys> {
    const hit = this.held.get(key);
    if (hit !== undefined && (hit.keys === null || hit.keys.expiresAt - REFRESH_MARGIN_MS > this.now())) return hit.pending;
    const entry: Held = { pending: mint(), keys: null };
    this.held.set(key, entry);
    entry.pending
      .then((keys) => {
        entry.keys = keys;
      })
      .catch((err: unknown) => {
        if (this.held.get(key) === entry) this.held.delete(key);
        log.debug({ key, err: errMsg(err) }, 'aws: a role was refused, the next call asks again');
      });
    return entry.pending;
  }

  clear(): void {
    this.held.clear();
  }
}

export interface AccessDeps {
  webIdentity: (roleArn: string) => Promise<RoleKeys>;
  assume: (base: AwsCredentials, roleArn: string, externalId: string, sessionName: string) => Promise<RoleKeys>;
  now: () => number;
}

export interface Access {
  metroRole: (roleArn: string) => AwsCredentials;
  reach: (metro: MetroAws, account: AwsAccount | null) => AwsCredentials;
  clear: () => void;
}

export function createAccess(deps: AccessDeps): Access {
  const cache = new RoleCache(deps.now);
  const metroRole = (roleArn: string): AwsCredentials => () => cache.get(`metro ${roleArn}`, () => deps.webIdentity(roleArn));
  const reach = (metro: MetroAws, account: AwsAccount | null): AwsCredentials => {
    if (account === null) return metro.credentials;
    const { role } = metro;
    return () => {
      if (role === null) return Promise.reject(new AwsError('NoRole', NO_ROLE, 'sts:AssumeRole'));
      const key = `${account.connection} ${account.roleArn} ${account.externalId}`;
      return cache.get(key, () => deps.assume(metroRole(role), account.roleArn, account.externalId, `metro-${account.connection}`));
    };
  };
  return {
    metroRole,
    reach,
    clear: () => {
      cache.clear();
    },
  };
}

export const access = createAccess({
  webIdentity: async (roleArn) => assumeRoleWithWebIdentity(roleArn, await flyOidcToken(STS_AUDIENCE), 'metro-api'),
  assume: assumeRole,
  now: () => Date.now(),
});
