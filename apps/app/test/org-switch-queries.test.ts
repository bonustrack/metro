import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AccountChangedError, clearAccount, storeAccount, type Account } from '@metro-labs/client/auth/account';
import { configurePlatform, memoryKeyValue } from '@metro-labs/client/platform';
import { dropStaleQueries, makeQueryClient } from '../src/lib/queries.ts';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (organization: string): string => `${b64({ alg: 'RS256' })}.${b64({ sub: 'user_1', sid: 'session_1', org_id: organization, role: 'admin', exp: 4_102_444_800 })}.sig`;
const account = (organization: string): Account => ({
  accessToken: token(organization), refreshToken: 'rt', organization, organizationName: null, organizationSlug: null, role: 'admin',
  user: { id: 'user_1', email: null, name: null, picture: null },
});

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue() });
  storeAccount(account('org_01STAGELABS0'));
});

afterEach(() => {
  clearAccount();
});

describe('queries across an organization switch', () => {
  test('reads still in flight for the old organization are dropped without an error, and the organization list is kept', async () => {
    const client = makeQueryClient(() => undefined);
    const stop = dropStaleQueries(client);
    try {
      let release = (): void => undefined;
      const answered = new Promise<void>((done) => { release = done; });
      const stale = client.fetchQuery({ queryKey: ['org', 'org_01STAGELABS0', 'servers'], queryFn: () => answered.then(() => ['agents of the next organization']) });
      const listing = client.fetchQuery({ queryKey: ['organizations', 'user_1'], queryFn: () => answered.then(() => ['every organization']) });
      storeAccount(account('org_01SNAPSHOT00'));
      release();
      await expect(stale).rejects.toThrow();
      expect(client.getQueryData(['org', 'org_01STAGELABS0', 'servers'])).toBeUndefined();
      expect(client.getQueryState(['org', 'org_01STAGELABS0', 'servers'])?.error).toBeNull();
      expect(await listing).toEqual(['every organization']);
    } finally {
      stop();
    }
  });

  test('a read dropped because the account moved is never retried under the new account', async () => {
    const client = makeQueryClient(() => undefined);
    let runs = 0;
    const moved = client.fetchQuery({ queryKey: ['org', 'org_01STAGELABS0', 'latest-usage'], retryDelay: 0, queryFn: () => { runs += 1; return Promise.reject(new AccountChangedError()); } });
    await expect(moved).rejects.toBeInstanceOf(AccountChangedError);
    expect(runs).toBe(1);
    let offline = 0;
    const down = client.fetchQuery({ queryKey: ['org', 'org_01STAGELABS0', 'usage'], retryDelay: 0, queryFn: () => { offline += 1; return Promise.reject(new Error('offline')); } });
    await expect(down).rejects.toThrow('offline');
    expect(offline).toBe(3);
  });
});
