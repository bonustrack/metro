import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';

export interface FakeWorkos {
  base: string;
  issuer: FakeIssuer;
  calls: { path: string; body: Record<string, unknown>; auth: string | null }[];
  codes: Map<string, { organization: string | null }>;
  organizations: string[];
  close: () => Promise<void>;
}

async function body(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    return {};
  }
}

export async function fakeWorkos(): Promise<FakeWorkos> {
  const issuer = await fakeIssuer();
  const calls: FakeWorkos['calls'] = [];
  const codes = new Map<string, { organization: string | null }>();
  const organizations: string[] = [];
  let refreshCount = 0;
  const tokens = (organization: string | null, sub = 'user_01ABC'): Record<string, unknown> => ({
    user: { id: sub, email: 'admin@stage.box', first_name: 'Stage', last_name: 'Labs', profile_picture_url: 'https://pic.example/a.png' },
    organization_id: organization,
    access_token: issuer.mint(sessionClaims({ sub, org_id: organization ?? undefined, role: organization === null ? undefined : 'admin' })),
    refresh_token: `rt_${String(++refreshCount)}`,
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    };
    if (url.pathname === '/user_management/authorize') {
      const code = `code_${String(codes.size + 1)}`;
      codes.set(code, { organization: organizations[0] ?? null });
      res.writeHead(302, { location: `${url.searchParams.get('redirect_uri') ?? ''}?code=${code}&state=${url.searchParams.get('state') ?? ''}` }).end();
      return;
    }
    body(req)
      .then((parsed) => {
        calls.push({ path: url.pathname, body: parsed, auth: typeof req.headers.authorization === 'string' ? req.headers.authorization : null });
        if (url.pathname === '/user_management/authenticate') {
          if (parsed.client_secret !== 'sk_test_fake') return send(401, { code: 'invalid_client', message: 'bad client secret' });
          if (parsed.grant_type === 'authorization_code') {
            const known = codes.get(String(parsed.code));
            if (known === undefined) return send(400, { code: 'invalid_grant', message: 'unknown code' });
            codes.delete(String(parsed.code));
            return send(200, tokens(known.organization));
          }
          if (parsed.grant_type === 'refresh_token') {
            if (String(parsed.refresh_token) === 'rt_dead') return send(400, { code: 'invalid_grant', message: 'refresh token revoked' });
            return send(200, tokens(typeof parsed.organization_id === 'string' ? parsed.organization_id : organizations[0] ?? null));
          }
          return send(400, { code: 'invalid_grant', message: 'unknown grant' });
        }
        if (url.pathname === '/user_management/sessions/revoke') return send(200, {});
        if (url.pathname === '/organizations') {
          const id = `org_01FAKE${String(organizations.length + 1).padStart(6, '0')}`;
          organizations.push(id);
          return send(201, { id, name: parsed.name });
        }
        if (url.pathname === '/user_management/organization_memberships') return send(201, { id: 'om_01', role: { slug: parsed.role_slug } });
        return send(404, { message: 'no such route' });
      })
      .catch(() => {
        send(500, {});
      });
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    base,
    issuer,
    calls,
    codes,
    organizations,
    close: async () => {
      await issuer.close();
      await new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      });
    },
  };
}
