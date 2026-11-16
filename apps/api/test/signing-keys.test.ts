import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPublicKey, generateKeyPairSync, randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { METRO_ISSUER, SigningKeys, verifyToken } from '@metro-labs/http/workos-token';
import { handleJwksRequest, mintAccessToken, readSigningKeys, thumbprint, type AuthKeys } from '../src/auth/signing-keys.ts';
import { handleServersApiRequest, type ServersApiDeps } from '../src/servers.ts';
import type { ServerEntry } from '../src/server-types.ts';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';

const pem = (bits = 2048): string => generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CURRENT = pem();
const NEXT = pem();
const USER = 'user_01M2TN3K6NRVX675M617GR4WVE';
const claimsOf = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
const headerOf = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

const ROW: ServerEntry = { id: 'srv00000001', kind: 'box', host: 'suzy.tail1234.ts.net', name: 'Suzy', addedAt: '2026-11-16T09:00:00.000Z', instanceId: null, launchedAt: null, avatar: null, slug: null, awsConnection: null };
const refuse = (): Promise<never> => Promise.reject(new Error('not used'));

let server: Server;
let base = '';
let authKeys: AuthKeys;

beforeAll(async () => {
  authKeys = readSigningKeys({ METRO_AUTH_SIGNING_KEY: CURRENT, METRO_AUTH_NEXT_SIGNING_KEY: NEXT });
  const workos = await testKeys();
  const deps: ServersApiDeps = {
    list: (owner) => Promise.resolve(owner === TEST_OWNER ? [ROW] : []),
    add: refuse,
    addRemote: refuse,
    rename: refuse,
    remove: refuse,
    move: refuse,
    avatar: refuse,
    keys: new SigningKeys(workos.workos, authKeys),
  };
  server = createServer((req, res) => {
    if (handleJwksRequest(req, res, authKeys)) return;
    if (handleServersApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

describe('the signing keys of api.metro.box', () => {
  test('the kid is the RFC 7638 thumbprint of the public key', () => {
    const example = createPublicKey({
      key: {
        kty: 'RSA',
        e: 'AQAB',
        n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
      },
      format: 'jwk',
    });
    expect(thumbprint(example)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  test('no key set means no signer and an empty key set; a bad, small or non-RSA key is ignored', () => {
    expect(readSigningKeys({})).toMatchObject({ signer: null, jwks: { keys: [] } });
    expect(readSigningKeys({ METRO_AUTH_SIGNING_KEY: '  ' }).signer).toBeNull();
    expect(readSigningKeys({ METRO_AUTH_SIGNING_KEY: 'not a pem' }).signer).toBeNull();
    expect(readSigningKeys({ METRO_AUTH_SIGNING_KEY: pem(1024) }).signer).toBeNull();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(readSigningKeys({ METRO_AUTH_SIGNING_KEY: ec }).signer).toBeNull();
    const publicOnly = createPublicKey(CURRENT).export({ type: 'spki', format: 'pem' }).toString();
    expect(readSigningKeys({ METRO_AUTH_SIGNING_KEY: publicOnly }).signer).toBeNull();
    expect(readSigningKeys({ METRO_AUTH_SIGNING_KEY: CURRENT.replace(/\n/g, '\\n') }).signer?.kid).toBe(authKeys.signer?.kid);
  });

  test('the current key and the next one are published, the current one first, each once, and only the current one signs', () => {
    expect(authKeys.jwks.keys.map((key) => key.kid)).toEqual([String(authKeys.signer?.kid), thumbprint(createPublicKey(NEXT))]);
    for (const key of authKeys.jwks.keys) {
      expect(Object.keys(key).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', e: 'AQAB' });
    }
    expect(JSON.stringify(authKeys.jwks)).not.toMatch(/"(d|p|q|dp|dq|qi)"/);
    expect(readSigningKeys({ METRO_AUTH_SIGNING_KEY: CURRENT, METRO_AUTH_NEXT_SIGNING_KEY: CURRENT }).jwks.keys).toHaveLength(1);
    const ahead = readSigningKeys({ METRO_AUTH_NEXT_SIGNING_KEY: NEXT });
    expect(ahead.signer).toBeNull();
    expect(ahead.jwks.keys).toHaveLength(1);
  });

  test('a minted token follows the contract: RS256, typ JWT, the kid, the issuer, ten minutes', async () => {
    const now = Date.now();
    const token = mintAccessToken(authKeys, { sub: USER, sid: 'session_01ABC', org_id: TEST_OWNER, role: 'member' }, now);
    expect(headerOf(token)).toEqual({ alg: 'RS256', typ: 'JWT', kid: String(authKeys.signer?.kid) });
    const iat = Math.floor(now / 1000);
    expect(claimsOf(token)).toEqual({ iss: METRO_ISSUER, sub: USER, sid: 'session_01ABC', org_id: TEST_OWNER, role: 'member', iat, exp: iat + 600 });
    expect(await verifyToken(token, new SigningKeys('http://127.0.0.1:1/nowhere', authKeys), now)).toMatchObject({ userId: USER, organization: TEST_OWNER, role: 'member' });
    const bare = mintAccessToken(authKeys, { sub: USER, sid: 'session_01ABC' }, now);
    expect(Object.keys(claimsOf(bare)).sort()).toEqual(['exp', 'iat', 'iss', 'sid', 'sub']);
  });

  test('minting refuses without a signer and refuses claims outside the contract', () => {
    expect(() => mintAccessToken(readSigningKeys({}), { sub: USER, sid: 's' })).toThrow('METRO_AUTH_SIGNING_KEY');
    expect(() => mintAccessToken(authKeys, { sub: 'user_01ABC', sid: 's' })).toThrow('user id');
    expect(() => mintAccessToken(authKeys, { sub: USER, sid: '' })).toThrow('session id');
    expect(() => mintAccessToken(authKeys, { sub: USER, sid: 's', org_id: TEST_OWNER })).toThrow('together');
    expect(() => mintAccessToken(authKeys, { sub: USER, sid: 's', role: 'admin' })).toThrow('together');
    expect(() => mintAccessToken(authKeys, { sub: USER, sid: 's', org_id: 'acme', role: 'admin' })).toThrow('organization id');
  });
});

describe('GET /.well-known/jwks.json', () => {
  test('answers the public keys to anyone, kept five minutes, with CORS', async () => {
    const res = await fetch(`${base}/.well-known/jwks.json`, { headers: { origin: 'https://metro.box' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('max-age=300');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://metro.box');
    expect(await res.json()).toEqual(authKeys.jwks);
    const preflight = await fetch(`${base}/.well-known/jwks.json`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect((await fetch(`${base}/.well-known/jwks.json`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/.well-known/jwks.json?x=1`)).status).toBe(200);
  });
});

describe('a Metro token on an api route', () => {
  const list = (authorization: string): Promise<Response> => fetch(`${base}/api/servers`, { headers: { authorization } });

  test('a Metro token signed by the current or the next key is accepted like a WorkOS one, scoped to its organization', async () => {
    const own = await list(`Bearer ${mintAccessToken(authKeys, { sub: USER, sid: 'session_01ABC', org_id: TEST_OWNER, role: 'admin' })}`);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { servers: ServerEntry[] }).servers.map((row) => row.id)).toEqual([ROW.id]);
    const stranger = await list(`Bearer ${mintAccessToken(authKeys, { sub: USER, sid: 'session_01ABC', org_id: TEST_STRANGER, role: 'admin' })}`);
    expect(((await stranger.json()) as { servers: ServerEntry[] }).servers).toEqual([]);
    const rotated = readSigningKeys({ METRO_AUTH_SIGNING_KEY: NEXT });
    expect((await list(`Bearer ${mintAccessToken(rotated, { sub: USER, sid: 'session_01ABC', org_id: TEST_OWNER, role: 'admin' })}`)).status).toBe(200);
    expect((await list(await auth(TEST_OWNER))).status).toBe(200);
  });

  test('a Metro token from an unknown key, without an organization or living too long is 401', async () => {
    const stranger = readSigningKeys({ METRO_AUTH_SIGNING_KEY: pem() });
    expect((await list(`Bearer ${mintAccessToken(stranger, { sub: USER, sid: 'session_01ABC', org_id: TEST_OWNER, role: 'admin' })}`)).status).toBe(401);
    expect((await list(`Bearer ${mintAccessToken(authKeys, { sub: USER, sid: 'session_01ABC' })}`)).status).toBe(401);
    const old = mintAccessToken(authKeys, { sub: USER, sid: 'session_01ABC', org_id: TEST_OWNER, role: 'admin' }, Date.now() - 12 * 60_000);
    expect((await list(`Bearer ${old}`)).status).toBe(401);
  });
});
