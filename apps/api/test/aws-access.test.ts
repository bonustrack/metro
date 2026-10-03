import { describe, expect, test } from 'bun:test';
import { createAccess, REFRESH_MARGIN_MS, RoleCache, type AwsAccount, type MetroAws } from '../src/aws/access.ts';
import { AwsError, keysOf, type AwsCredentials } from '../src/aws/ec2.ts';
import type { RoleKeys } from '../src/aws/sts.ts';

const HOUR = 3_600_000;
const METRO_ROLE = 'arn:aws:iam::787391402827:role/metro-api';
const ACCOUNT: AwsAccount = { connection: 'conn0000001', roleArn: 'arn:aws:iam::111122223333:role/metro-access', externalId: 'ext-abcdefghijklmnop' };

const keys = (name: string, expiresAt: number): RoleKeys => ({ accessKeyId: `ASIA${name}`, secretAccessKey: 's', sessionToken: `t-${name}`, expiresAt });

describe('temporary AWS keys are kept until shortly before they expire', () => {
  test('one mint serves every call until the margin, then a fresh one is taken', async () => {
    let now = 0;
    let minted = 0;
    const cache = new RoleCache(() => now);
    const mint = (): Promise<RoleKeys> => {
      minted += 1;
      return Promise.resolve(keys(String(minted), now + HOUR));
    };
    expect((await cache.get('a', mint)).accessKeyId).toBe('ASIA1');
    now = HOUR - REFRESH_MARGIN_MS - 1;
    expect((await cache.get('a', mint)).accessKeyId).toBe('ASIA1');
    now = HOUR - REFRESH_MARGIN_MS;
    expect((await cache.get('a', mint)).accessKeyId).toBe('ASIA2');
    expect(minted).toBe(2);
    expect((await cache.get('b', mint)).accessKeyId).toBe('ASIA3');
  });

  test('calls that arrive together share one mint', async () => {
    let minted = 0;
    let release: (k: RoleKeys) => void = () => undefined;
    const cache = new RoleCache(() => 0);
    const mint = (): Promise<RoleKeys> => {
      minted += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const both = Promise.all([cache.get('a', mint), cache.get('a', mint)]);
    release(keys('X', HOUR));
    expect((await both).map((k) => k.accessKeyId)).toEqual(['ASIAX', 'ASIAX']);
    expect(minted).toBe(1);
  });

  test('a refusal is not kept: the next call asks AWS again', async () => {
    let tries = 0;
    const cache = new RoleCache(() => 0);
    const mint = (): Promise<RoleKeys> => {
      tries += 1;
      return tries === 1 ? Promise.reject(new AwsError('AccessDenied', 'no')) : Promise.resolve(keys('OK', HOUR));
    };
    await expect(cache.get('a', mint)).rejects.toThrow('no');
    await Promise.resolve();
    expect((await cache.get('a', mint)).accessKeyId).toBe('ASIAOK');
    expect(tries).toBe(2);
  });
});

describe("Metro reaches an account through its own role and the organization's external id", () => {
  const STATIC = { accessKeyId: 'AKIAMETRO', secretAccessKey: 's' };

  function setup(): { metro: (role: string | null) => MetroAws; access: ReturnType<typeof createAccess>; assumed: string[]; web: string[] } {
    const assumed: string[] = [];
    const web: string[] = [];
    const access = createAccess({
      webIdentity: (roleArn) => {
        web.push(roleArn);
        return Promise.resolve(keys('WEB', HOUR));
      },
      assume: async (base: AwsCredentials, roleArn, externalId, sessionName) => {
        assumed.push(`${(await keysOf(base)).accessKeyId} ${roleArn} ${externalId} ${sessionName}`);
        return keys('CONN', HOUR);
      },
      now: () => 0,
    });
    return { metro: (role) => ({ credentials: role === null ? STATIC : access.metroRole(role), role }), access, assumed, web };
  }

  test("a server in Metro's own account uses Metro's own credentials as they are", async () => {
    const { metro, access, assumed } = setup();
    expect(access.reach(metro(null), null)).toBe(STATIC);
    expect(await keysOf(access.reach(metro(METRO_ROLE), null))).toMatchObject({ accessKeyId: 'ASIAWEB', sessionToken: 't-WEB' });
    expect(assumed).toEqual([]);
  });

  test('a connected account is taken from the role, never from the key, with the external id and a session named after the connection', async () => {
    const { metro, access, assumed, web } = setup();
    const reached = access.reach({ credentials: STATIC, role: METRO_ROLE }, ACCOUNT);
    expect(await keysOf(reached)).toMatchObject({ accessKeyId: 'ASIACONN' });
    expect(await keysOf(reached)).toMatchObject({ accessKeyId: 'ASIACONN' });
    expect(assumed).toEqual([`ASIAWEB ${ACCOUNT.roleArn} ${ACCOUNT.externalId} metro-conn0000001`]);
    expect(web).toEqual([METRO_ROLE]);
    expect(metro(null).role).toBeNull();
  });

  test('without a role of its own, Metro refuses to reach another account', async () => {
    const { metro, access, assumed } = setup();
    await expect(keysOf(access.reach(metro(null), ACCOUNT))).rejects.toMatchObject({ code: 'NoRole' });
    expect(assumed).toEqual([]);
  });
});
