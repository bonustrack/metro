import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeIssuer {
  url: string;
  kid: string;
  issuer: string;
  mint: (claims: Record<string, unknown>, opts?: { kid?: string; alg?: string; key?: KeyObject }) => string;
  rotate: () => void;
  hits: () => number;
  close: () => Promise<void>;
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function fakeIssuer(): Promise<FakeIssuer> {
  let pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let kid = 'key-1';
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits += 1;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }));
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/sso/jwks/client_test`;
  const issuer = 'https://api.workos.com/';
  const mint: FakeIssuer['mint'] = (claims, opts = {}) => {
    const head = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? kid }));
    const body = b64url(JSON.stringify({ iss: issuer, ...claims }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${head}.${body}`);
    return `${head}.${body}.${b64url(signer.sign(opts.key ?? pair.privateKey))}`;
  };
  return {
    url,
    get kid() {
      return kid;
    },
    issuer,
    mint,
    rotate: () => {
      pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      kid = `key-${String(Number(kid.slice(4)) + 1)}`;
    },
    hits: () => hits,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      }),
  };
}

export const sessionClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: 'user_01ABC',
  sid: 'session_01XYZ',
  org_id: 'org_01BONUSTRACK',
  role: 'admin',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300,
  ...over,
});
