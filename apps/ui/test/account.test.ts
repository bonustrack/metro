import { describe, expect, test } from 'bun:test';
import { accountFrom, tokenExpiring, tokenExpiry } from '../src/auth/account.ts';
import { handoffCode } from '../src/auth/handoff.ts';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>): string => `${b64({ alg: 'RS256', kid: 'k' })}.${b64(claims)}.sig`;

describe('the signed-in account on the page', () => {
  test('the expiry is read off the token, and a token within a minute of it counts as expiring', () => {
    const now = 1_800_000_000_000;
    const exp = Math.floor(now / 1000) + 300;
    expect(tokenExpiry(jwt({ exp }))).toBe(exp * 1000);
    expect(tokenExpiring(jwt({ exp }), now)).toBe(false);
    expect(tokenExpiring(jwt({ exp }), now + 299_000)).toBe(true);
    expect(tokenExpiring('garbage', now)).toBe(true);
  });

  test('the exchange answer becomes an account, with the organization and role from the token', () => {
    const token = jwt({ sub: 'user_1', org_id: 'org_1', role: 'admin', exp: 9_999_999_999 });
    const account = accountFrom({ accessToken: token, refreshToken: 'rt', organization: 'org_1', user: { id: 'user_1', email: 'admin@stage.box', name: 'Stage Labs', picture: null } });
    expect(account).toEqual({ accessToken: token, refreshToken: 'rt', organization: 'org_1', organizationName: null, role: 'admin', user: { id: 'user_1', email: 'admin@stage.box', name: 'Stage Labs', picture: null } });
    const bare = accountFrom({ accessToken: jwt({ sub: 'user_1' }), refreshToken: 'rt', organization: null, user: { id: 'user_1' } });
    expect(bare.organization).toBeNull();
    expect(bare.role).toBeNull();
    expect(() => accountFrom({ user: { id: 'x' } })).toThrow();
  });

  test('the handoff code is read only from #/auth/<code>', () => {
    expect(handoffCode('#/auth/abcdefghijklmnop_-')).toBe('abcdefghijklmnop_-');
    expect(handoffCode('#/auth/short')).toBeNull();
    expect(handoffCode('#/servers')).toBeNull();
    expect(handoffCode('#/auth/abcdefghijklmnop/extra')).toBeNull();
  });
});
