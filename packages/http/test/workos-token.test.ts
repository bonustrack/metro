import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { bearerToken, SigningKeys, verifyToken } from '../src/workos-token.ts';
import { fakeIssuer, sessionClaims, type FakeIssuer } from './workos-fixture.ts';

let issuer: FakeIssuer;
beforeAll(async () => {
  issuer = await fakeIssuer();
});
afterAll(async () => {
  await issuer.close();
});

describe('a WorkOS access token on a metro server', () => {
  test('a valid token yields the user, the session, the organization and the role; the keys are fetched once', async () => {
    const keys = new SigningKeys(issuer.url);
    const session = await verifyToken(issuer.mint(sessionClaims()), keys);
    expect(session).toMatchObject({ userId: 'user_01ABC', sessionId: 'session_01XYZ', organization: 'org_01BONUSTRACK', role: 'admin' });
    await verifyToken(issuer.mint(sessionClaims({ sub: 'user_02' })), keys);
    expect(issuer.hits()).toBe(1);
  });

  test('expired, wrong issuer, wrong algorithm, tampered and foreign-key tokens are all refused', async () => {
    const keys = new SigningKeys(issuer.url);
    const past = Math.floor(Date.now() / 1000) - 120;
    expect(await verifyToken(issuer.mint(sessionClaims({ exp: past })), keys)).toBeNull();
    expect(await verifyToken(issuer.mint(sessionClaims({ iss: 'https://evil.example/' })), keys)).toBeNull();
    expect(await verifyToken(issuer.mint(sessionClaims(), { alg: 'none' }), keys)).toBeNull();
    const good = issuer.mint(sessionClaims());
    const [h, b, s] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ ...sessionClaims(), role: 'admin', sub: 'user_evil' })).toString('base64url');
    expect(await verifyToken(`${String(h)}.${forged}.${String(s)}`, keys)).toBeNull();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(await verifyToken(issuer.mint(sessionClaims(), { key: other.privateKey }), keys)).toBeNull();
    expect(await verifyToken('not.a.jwt', keys)).toBeNull();
    expect(await verifyToken(`${String(h)}.${String(b)}`, keys)).toBeNull();
  });

  test('a token from a rotated key triggers one refetch, and a still-unknown key does not hammer the issuer', async () => {
    const keys = new SigningKeys(issuer.url);
    expect(await verifyToken(issuer.mint(sessionClaims()), keys)).not.toBeNull();
    issuer.rotate();
    expect(await verifyToken(issuer.mint(sessionClaims()), keys)).not.toBeNull();
    const before = issuer.hits();
    expect(await verifyToken(issuer.mint(sessionClaims(), { kid: 'key-99' }), keys)).toBeNull();
    expect(issuer.hits()).toBe(before + 1);
    expect(await verifyToken(issuer.mint(sessionClaims(), { kid: 'key-98' }), keys)).toBeNull();
    expect(issuer.hits()).toBe(before + 1);
  });

  test('a cached key set on disk verifies without the network, and is written on a fetch', async () => {
    let saved: string | null = null;
    const writer = new SigningKeys(issuer.url, { read: () => null, write: (t) => { saved = t; } });
    expect(await verifyToken(issuer.mint(sessionClaims()), writer)).not.toBeNull();
    expect(saved).not.toBeNull();
    const dead = new SigningKeys('http://127.0.0.1:1/nowhere', { read: () => saved, write: () => undefined });
    expect(await verifyToken(issuer.mint(sessionClaims()), dead)).not.toBeNull();
  });

  test('the bearer header is read only as a bearer carrying a JWT shape', () => {
    const req = (authorization?: string): { headers: { authorization?: string } } => ({ headers: authorization === undefined ? {} : { authorization } });
    expect(bearerToken(req('Bearer a.b.c') as never)).toBe('a.b.c');
    expect(bearerToken(req('bearer a.b.c') as never)).toBe('a.b.c');
    expect(bearerToken(req('Metro 0xabc 1 0xsig') as never)).toBeNull();
    expect(bearerToken(req('Bearer mk_agentkey') as never)).toBeNull();
    expect(bearerToken(req() as never)).toBeNull();
  });
});
