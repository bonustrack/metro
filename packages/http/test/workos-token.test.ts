import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, createPublicKey, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { bearerToken, JwksKeys, METRO_ISSUER, metroAuthBase, metroJwksUrl, metroKeys, SigningKeys, verifyToken } from '../src/workos-token.ts';
import { fakeIssuer, sessionClaims, type FakeIssuer } from './workos-fixture.ts';

let issuer: FakeIssuer;
let metro: FakeIssuer;
beforeAll(async () => {
  issuer = await fakeIssuer();
  metro = await fakeIssuer(METRO_ISSUER);
});
afterAll(async () => {
  await issuer.close();
  await metro.close();
});

const both = (): SigningKeys => new SigningKeys(issuer.url, new JwksKeys(metro.url));
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

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
    expect(await verifyToken(issuer.mint(sessionClaims({ iss: 'https://api.workos.com.evil.example' })), keys)).toBeNull();
    expect(await verifyToken(issuer.mint(sessionClaims({ iss: 'https://api.workos.com/' })), keys)).not.toBeNull();
    expect(await verifyToken(issuer.mint(sessionClaims({ iss: 'https://api.workos.com/user_management/client_test' })), keys)).not.toBeNull();
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
    const writer = new SigningKeys(new JwksKeys(issuer.url, { read: () => null, write: (t) => { saved = t; } }));
    expect(await verifyToken(issuer.mint(sessionClaims()), writer)).not.toBeNull();
    expect(saved).not.toBeNull();
    const dead = new SigningKeys(new JwksKeys('http://127.0.0.1:1/nowhere', { read: () => saved, write: () => undefined }));
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

describe('a Metro access token next to WorkOS ones', () => {
  test('a valid Metro token yields its session; a WorkOS token still works on the same keys', async () => {
    const keys = both();
    expect(await verifyToken(metro.mint(sessionClaims({ exp: Math.floor(Date.now() / 1000) + 600 })), keys)).toMatchObject({ userId: 'user_01ABC', sessionId: 'session_01XYZ', organization: 'org_01BONUSTRACK', role: 'admin' });
    expect(await verifyToken(issuer.mint(sessionClaims()), keys)).not.toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims({ org_id: undefined, role: undefined })), keys)).toMatchObject({ organization: null, role: null });
  });

  test('each issuer is checked only against its own key set, and a server with no Metro set refuses Metro tokens', async () => {
    const keys = both();
    const signedByWorkos = issuer.mint(sessionClaims({ iss: METRO_ISSUER }), { kid: metro.kid });
    expect(await verifyToken(signedByWorkos, keys)).toBeNull();
    const signedByMetro = metro.mint(sessionClaims({ iss: 'https://api.workos.com' }), { kid: issuer.kid });
    expect(await verifyToken(signedByMetro, keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims()), new SigningKeys(issuer.url))).toBeNull();
    for (const iss of ['https://api.metro.box/', 'https://api.metro.box.evil.example', 'http://api.metro.box', 'https://evil.example', undefined]) {
      expect(await verifyToken(metro.mint(sessionClaims({ iss })), keys)).toBeNull();
    }
  });

  test('alg none, HS256 keyed with the public key, a missing kid and a missing or other typ are refused', async () => {
    const keys = both();
    expect(await verifyToken(metro.mint(sessionClaims(), { alg: 'none' }), keys)).toBeNull();
    const unsigned = `${b64({ alg: 'none', typ: 'JWT', kid: metro.kid })}.${b64({ iss: METRO_ISSUER, ...sessionClaims() })}.`;
    expect(await verifyToken(unsigned, keys)).toBeNull();
    const published = (await (await fetch(metro.url)).json()) as { keys: JsonWebKey[] };
    const publicPem = String(createPublicKey({ key: published.keys[0] ?? {}, format: 'jwk' }).export({ type: 'spki', format: 'pem' }));
    const signed = `${b64({ alg: 'HS256', typ: 'JWT', kid: metro.kid })}.${b64({ iss: METRO_ISSUER, ...sessionClaims() })}`;
    expect(await verifyToken(`${signed}.${createHmac('sha256', publicPem).update(signed).digest('base64url')}`, keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims(), { kid: null }), keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims(), { typ: null }), keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims(), { typ: 'at+jwt' }), keys)).toBeNull();
  });

  test('a Metro token needs iat, lives an hour at most and is not issued in the future', async () => {
    const keys = both();
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyToken(metro.mint(sessionClaims({ iat: now, exp: now + 3600 })), keys)).not.toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims({ iat: now, exp: now + 3601 })), keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims({ iat: now - 3500, exp: now + 3500 })), keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims({ iat: undefined })), keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims({ iat: String(now) })), keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims({ iat: now + 365 * 86400, exp: now + 365 * 86400 + 600 })), keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims({ iat: now + 240, exp: now + 840 })), keys)).not.toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims({ iat: now + 360, exp: now + 960 })), keys)).toBeNull();
    expect(await verifyToken(metro.mint(sessionClaims({ iat: now - 900, exp: now - 300 })), keys)).toBeNull();
    expect(await verifyToken(issuer.mint(sessionClaims({ iat: undefined, exp: now + 7200 })), keys)).not.toBeNull();
  });

  test('an unknown kid refetches the Metro set once a minute at most, and a known one needs no fetch', async () => {
    const own = await fakeIssuer(METRO_ISSUER);
    try {
      const keys = new SigningKeys(issuer.url, new JwksKeys(own.url, undefined, 3_600_000));
      const t0 = Date.now();
      expect(await verifyToken(own.mint(sessionClaims()), keys, t0)).not.toBeNull();
      expect(await verifyToken(own.mint(sessionClaims()), keys, t0 + 1000)).not.toBeNull();
      expect(own.hits()).toBe(1);
      own.rotate();
      expect(await verifyToken(own.mint(sessionClaims()), keys, t0 + 2000)).not.toBeNull();
      expect(own.hits()).toBe(2);
      expect(await verifyToken(own.mint(sessionClaims(), { kid: 'key-99' }), keys, t0 + 3000)).toBeNull();
      expect(await verifyToken(own.mint(sessionClaims(), { kid: 'key-98' }), keys, t0 + 4000)).toBeNull();
      expect(own.hits()).toBe(3);
      own.rotate();
      expect(await verifyToken(own.mint(sessionClaims()), keys, t0 + 30_000)).toBeNull();
      expect(own.hits()).toBe(3);
      expect(await verifyToken(own.mint(sessionClaims()), keys, t0 + 64_000)).not.toBeNull();
      expect(own.hits()).toBe(4);
    } finally {
      await own.close();
    }
  });

  test('a set older than an hour is fetched again: a removed key stops working, and a failed fetch keeps the old set', async () => {
    const own = await fakeIssuer(METRO_ISSUER);
    const at = (ms: number, kid?: string): string => own.mint(sessionClaims({ iat: Math.floor(ms / 1000), exp: Math.floor(ms / 1000) + 600 }), kid === undefined ? {} : { kid });
    try {
      const keys = new SigningKeys(issuer.url, new JwksKeys(own.url, undefined, 3_600_000));
      const t0 = Date.now();
      expect(await verifyToken(at(t0), keys, t0)).not.toBeNull();
      own.answer(503);
      expect(await verifyToken(at(t0 + 3_601_000), keys, t0 + 3_601_000)).not.toBeNull();
      expect(own.hits()).toBe(2);
      own.answer(200, false);
      expect(await verifyToken(at(t0 + 3_700_000), keys, t0 + 3_700_000)).not.toBeNull();
      expect(own.hits()).toBe(3);
      own.answer(200);
      own.rotate();
      expect(await verifyToken(at(t0 + 3_800_000, 'key-1'), keys, t0 + 3_800_000)).toBeNull();
      expect(own.hits()).toBe(4);
      expect(await verifyToken(at(t0 + 3_800_500), keys, t0 + 3_800_500)).not.toBeNull();
      expect(own.hits()).toBe(4);
    } finally {
      await own.close();
    }
  });

  test('a set read from disk is used while the network is down', async () => {
    let saved: string | null = null;
    const store = { read: () => saved, write: (text: string) => { saved = text; } };
    await new JwksKeys(metro.url, store).refresh();
    expect(saved).toContain('"keys"');
    const offline = new SigningKeys(issuer.url, new JwksKeys('http://127.0.0.1:1/nowhere', store, 3_600_000));
    expect(await verifyToken(metro.mint(sessionClaims()), offline)).not.toBeNull();
  });

  test('the Metro key set url is fixed, and METRO_AUTH_BASE alone moves it', async () => {
    expect(metroJwksUrl(metroAuthBase({}))).toBe('https://api.metro.box/.well-known/jwks.json');
    expect(metroJwksUrl(metroAuthBase({ METRO_AUTH_BASE: ' ' }))).toBe('https://api.metro.box/.well-known/jwks.json');
    expect(metroJwksUrl(metroAuthBase({ METRO_AUTH_BASE: 'http://127.0.0.1:12345' }))).toBe('http://127.0.0.1:12345/.well-known/jwks.json');
    const before = metro.hits();
    const keys = new SigningKeys(issuer.url, metroKeys({ METRO_AUTH_BASE: metro.base }));
    expect(await verifyToken(metro.mint(sessionClaims()), keys)).not.toBeNull();
    expect(metro.hits()).toBe(before + 1);
  });
});
