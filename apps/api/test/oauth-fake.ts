import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { googleProvider, microsoftProvider, type OAuthProviders, type ProviderId } from '../src/auth/providers.ts';

export const GOOGLE_CLIENT = 'google-client.apps.example';
export const MICROSOFT_CLIENT = '00000000-1111-2222-3333-444444444444';
export const WORK_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

interface Issued {
  provider: ProviderId;
  claims: Record<string, unknown>;
  challenge: string;
  key: 'right' | 'other';
}

export interface Exchange {
  provider: string;
  form: URLSearchParams;
}

export interface FakeProviders {
  providers: OAuthProviders;
  exchanges: Exchange[];
  issue: (issued: Issued) => string;
  close: () => Promise<void>;
}

const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function idToken(claims: Record<string, unknown>, key: KeyObject): string {
  const head = `${encoded({ alg: 'RS256', kid: 'fake-key-1', typ: 'JWT' })}.${encoded(claims)}`;
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}

async function formOf(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const CLIENTS: Record<ProviderId, { id: string; secret: string }> = {
  google: { id: GOOGLE_CLIENT, secret: 'google-secret' },
  microsoft: { id: MICROSOFT_CLIENT, secret: 'microsoft-secret' },
};

export async function fakeProviders(redirectUri: () => string): Promise<FakeProviders> {
  const right = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map<string, Issued>();
  const exchanges: Exchange[] = [];
  const server: Server = createServer((req, res) => {
    const [, provider, what] = (req.url ?? '').split('/');
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (what === 'jwks') {
      send(200, { keys: [{ ...right.publicKey.export({ format: 'jwk' }), kid: 'fake-key-1', alg: 'RS256', use: 'sig' }] });
      return;
    }
    formOf(req)
      .then((form) => {
        exchanges.push({ provider: provider ?? '', form });
        const issued = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const client = issued === undefined ? undefined : CLIENTS[issued.provider];
        const verifier = form.get('code_verifier') ?? '';
        const pkce = createHash('sha256').update(verifier).digest('base64url');
        if (issued === undefined || client === undefined || issued.provider !== provider) return send(400, { error: 'invalid_grant' });
        if (form.get('client_id') !== client.id || form.get('client_secret') !== client.secret) return send(401, { error: 'invalid_client' });
        if (form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== redirectUri() || pkce !== issued.challenge) return send(400, { error: 'invalid_grant' });
        return send(200, { id_token: idToken(issued.claims, issued.key === 'right' ? right.privateKey : other.privateKey), access_token: 'provider-access', token_type: 'Bearer' });
      })
      .catch(() => {
        send(500, {});
      });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const endpoints = (id: ProviderId): { authorize: string; token: string; jwks: string } => ({ authorize: `https://${id}.example/authorize`, token: `${base}/${id}/token`, jwks: `${base}/${id}/jwks` });
  let issuedCount = 0;
  return {
    providers: {
      google: googleProvider({ clientId: GOOGLE_CLIENT, clientSecret: 'google-secret' }, endpoints('google')),
      microsoft: microsoftProvider({ clientId: MICROSOFT_CLIENT, clientSecret: 'microsoft-secret' }, endpoints('microsoft')),
    },
    exchanges,
    issue: (issued) => {
      issuedCount += 1;
      const code = `code-${String(issuedCount)}`;
      codes.set(code, issued);
      return code;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export function googleClaims(nonce: string, now: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(now / 1000);
  return { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: '104857600000000000001', email: 'ana@example.com', email_verified: true, hd: 'example.com', name: 'Ana Lima', picture: 'https://lh3.example/ana.png', iat, exp: iat + 600, nonce, ...extra };
}

export function microsoftClaims(nonce: string, now: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(now / 1000);
  const tid = typeof extra.tid === 'string' ? extra.tid : WORK_TENANT;
  return { iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: MICROSOFT_CLIENT, tid, oid: '3b5a7c1e-2d4f-4a6b-8c9d-0e1f2a3b4c5d', email: 'ana@anderra.ch', xms_edov: true, name: 'Ana Lima', preferred_username: 'ana@anderra.ch', iat, nbf: iat, exp: iat + 600, nonce, ...extra };
}
