import { storeAccount, type Account } from '../src/auth/account.js';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

export const TEST_ORGANIZATION = 'org_01TESTOWNER000000';

export function testToken(claims: Record<string, unknown> = {}): string {
  return `${b64({ alg: 'RS256', kid: 'k' })}.${b64({ sub: 'user_1', sid: 'session_1', org_id: TEST_ORGANIZATION, role: 'admin', exp: 4_102_444_800, ...claims })}.sig`;
}

export function installTestAccount(claims: Record<string, unknown> = {}): Account {
  const account: Account = {
    accessToken: testToken(claims),
    refreshToken: 'rt_test',
    organization: typeof claims.org_id === 'string' ? claims.org_id : TEST_ORGANIZATION,
    role: typeof claims.role === 'string' ? claims.role : 'admin',
    user: { id: 'user_1', email: 'admin@stage.box', name: 'Stage Labs', picture: null },
  };
  storeAccount(account);
  return account;
}
