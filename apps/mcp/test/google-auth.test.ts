import { describe, expect, test } from 'bun:test';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import {
  agentsForEmail,
  GoogleAuthError,
  parseEmailAgentMap,
  verifyGoogleIdToken,
} from '../src/daemon/google-auth.ts';

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(kp.publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256' };
const certs = (): Promise<(typeof jwk)[]> => Promise.resolve([jwk]);

interface Claims {
  iss?: string;
  aud?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean | string;
}

function mint(
  claims: Claims,
  opts: { kid?: string; alg?: string; key?: KeyObject } = {},
): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' };
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${h}.${p}`), opts.key ?? kp.privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

const NOW = 1_800_000_000_000;
const valid: Claims = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  exp: Math.floor(NOW / 1000) + 3600,
  email: 'Fabien@bonustrack.co',
  email_verified: true,
};
const verify = (token: string): ReturnType<typeof verifyGoogleIdToken> =>
  verifyGoogleIdToken(token, { clientId: CLIENT_ID, now: NOW, fetchCerts: certs });

describe('verifyGoogleIdToken', () => {
  test('accepts a valid token and lowercases the email', async () => {
    const claims = await verify(mint(valid));
    expect(claims.email).toBe('fabien@bonustrack.co');
    expect(claims.aud).toBe(CLIENT_ID);
  });

  test('rejects a wrong audience', async () => {
    await expect(verify(mint({ ...valid, aud: 'someone-else' }))).rejects.toBeInstanceOf(
      GoogleAuthError,
    );
  });

  test('rejects an expired token (beyond clock skew)', async () => {
    await expect(
      verify(mint({ ...valid, exp: Math.floor(NOW / 1000) - 120 })),
    ).rejects.toThrow(/expired/);
  });

  test('rejects an unverified email', async () => {
    await expect(verify(mint({ ...valid, email_verified: false }))).rejects.toThrow(
      /email not verified/,
    );
  });

  test('rejects an unexpected issuer', async () => {
    await expect(verify(mint({ ...valid, iss: 'https://evil.example' }))).rejects.toThrow(
      /issuer/,
    );
  });

  test('rejects an unknown signing key id', async () => {
    await expect(verify(mint(valid, { kid: 'other' }))).rejects.toThrow(/signing key/);
  });

  test('rejects a tampered signature (different key)', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(verify(mint(valid, { key: other.privateKey }))).rejects.toThrow(
      /invalid signature/,
    );
  });

  test('rejects a non-RS256 alg', async () => {
    await expect(verify(mint(valid, { alg: 'none' }))).rejects.toThrow(/alg/);
  });

  test('rejects a non-JWT token', async () => {
    await expect(verify('not-a-jwt')).rejects.toThrow(/not a JWT/);
  });
});

describe('parseEmailAgentMap / agentsForEmail', () => {
  test('parses and lowercases emails', () => {
    const map = parseEmailAgentMap('{"Fabien@bonustrack.co":["tony"]}');
    expect(agentsForEmail(map, 'fabien@bonustrack.co')).toEqual(['tony']);
    expect(agentsForEmail(map, 'FABIEN@bonustrack.co')).toEqual(['tony']);
  });

  test('empty or undefined config yields no mapping', () => {
    expect(parseEmailAgentMap(undefined)).toEqual({});
    expect(agentsForEmail(parseEmailAgentMap(''), 'x@y.z')).toBeUndefined();
  });

  test('unknown email is undefined', () => {
    const map = parseEmailAgentMap('{"a@b.co":["tony"]}');
    expect(agentsForEmail(map, 'other@b.co')).toBeUndefined();
  });

  test('empty agent list is treated as unauthorized', () => {
    const map = parseEmailAgentMap('{"a@b.co":[]}');
    expect(agentsForEmail(map, 'a@b.co')).toBeUndefined();
  });

  test('throws on invalid JSON', () => {
    expect(() => parseEmailAgentMap('{not json')).toThrow(GoogleAuthError);
  });

  test('throws on non-string-array values', () => {
    expect(() => parseEmailAgentMap('{"a@b.co":"tony"}')).toThrow(GoogleAuthError);
  });
});
