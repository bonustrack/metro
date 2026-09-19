import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';

export interface FakeWorkos {
  base: string;
  issuer: FakeIssuer;
  calls: { path: string; body: Record<string, unknown>; auth: string | null }[];
  codes: Map<string, { organization: string | null }>;
  organizations: string[];
  enabled: Set<string>;
  members: { id: string; user_id: string; role: string }[];
  invitations: { id: string; email: string; state: string; role_slug: string }[];
  outage: { on: boolean };
  selection: { on: boolean };
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
  const enabled = new Set<string>(['GoogleOAuth']);
  const members: FakeWorkos['members'] = [{ id: 'om_admin', user_id: 'user_01ABC', role: 'admin' }, { id: 'om_bob', user_id: 'user_02BOB', role: 'member' }];
  const invitations: FakeWorkos['invitations'] = [];
  const USERS = [
    { id: 'user_01ABC', email: 'admin@stage.box', first_name: 'Stage', last_name: 'Labs' as string | null, profile_picture_url: 'https://pic.example/a.png' as string | null },
    { id: 'user_02BOB', email: 'bob@stage.box', first_name: 'Bob', last_name: null as string | null, profile_picture_url: null as string | null },
  ];
  let refreshCount = 0;
  const outage = { on: false };
  const selection = { on: false };
  let orgName = 'Stage Labs';
  const tokens = (organization: string | null, sub = 'user_01ABC'): Record<string, unknown> => ({
    user: USERS.find((u) => u.id === sub) ?? { id: sub, email: 'admin@stage.box', first_name: 'Stage', last_name: 'Labs', profile_picture_url: 'https://pic.example/a.png' },
    organization_id: organization,
    access_token: issuer.mint(sessionClaims({ sub, org_id: organization ?? undefined, role: organization === null ? undefined : 'admin' })),
    refresh_token: `rt_${String(++refreshCount)}`,
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    };
    if (outage.on) {
      send(500, { message: 'WorkOS is having a bad minute' });
      return;
    }
    if (url.pathname === '/user_management/authorize') {
      if (!enabled.has(url.searchParams.get('provider') ?? '')) return send(404, { message: 'Not Found' });
      if (url.searchParams.get('state') === 'probe') {
        res.writeHead(302, { location: 'https://accounts.google.com/o/oauth2/v2/auth?probe=1' }).end();
        return;
      }
      const code = `code_${String(codes.size + 1)}`;
      codes.set(code, { organization: organizations[0] ?? null });
      res.writeHead(302, { location: `${url.searchParams.get('redirect_uri') ?? ''}?code=${code}&state=${url.searchParams.get('state') ?? ''}` }).end();
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/organizations/')) {
      send(200, { id: url.pathname.slice('/organizations/'.length), name: orgName });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/user_management/users') {
      send(200, { data: USERS.filter((u) => members.some((m) => m.user_id === u.id)) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/user_management/organization_memberships') {
      const user = url.searchParams.get('user_id');
      if (user !== null) {
        send(200, { data: organizations.map((id, i) => ({ id: `om_${String(i)}`, user_id: user, organization_id: id, role: { slug: 'admin' }, status: 'active' })) });
        return;
      }
      send(200, { data: members.map((m) => ({ id: m.id, user_id: m.user_id, organization_id: url.searchParams.get('organization_id'), role: { slug: m.role }, status: 'active' })) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/user_management/invitations') {
      send(200, { data: invitations.map((i) => ({ ...i, expires_at: '2026-09-26T00:00:00.000Z' })) });
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/user_management/organization_memberships/')) {
      const id = url.pathname.split('/').pop() ?? '';
      const at = members.findIndex((m) => m.id === id);
      if (at !== -1) members.splice(at, 1);
      send(at === -1 ? 404 : 200, {});
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
            if (selection.on)
              return send(422, {
                code: 'organization_selection_required',
                message: 'The user must choose an organization to finish their authentication.',
                pending_authentication_token: 'pat_select',
                organizations: organizations.map((id) => ({ id, name: 'Org' })),
              });
            return send(200, tokens(known.organization));
          }
          if (parsed.grant_type === 'urn:workos:oauth:grant-type:organization-selection') {
            if (parsed.pending_authentication_token !== 'pat_select') return send(400, { code: 'invalid_grant', message: 'bad pending token' });
            return send(200, tokens(String(parsed.organization_id)));
          }
          if (parsed.grant_type === 'refresh_token') {
            if (String(parsed.refresh_token) === 'rt_dead') return send(400, { code: 'invalid_grant', message: 'refresh token revoked' });
            return send(200, tokens(typeof parsed.organization_id === 'string' ? parsed.organization_id : organizations[0] ?? null));
          }
          return send(400, { code: 'invalid_grant', message: 'unknown grant' });
        }
        if (url.pathname === '/user_management/sessions/revoke') return send(200, {});
        if (url.pathname.startsWith('/user_management/users/') && req.method === 'PUT') {
          const who = USERS.find((u) => u.id === url.pathname.split('/').pop());
          if (who === undefined) return send(404, { message: 'no such user' });
          if (typeof parsed.first_name === 'string') who.first_name = parsed.first_name;
          if (typeof parsed.last_name === 'string') who.last_name = parsed.last_name === '' ? null : parsed.last_name;
          return send(200, who);
        }
        if (url.pathname.startsWith('/organizations/') && req.method === 'PUT') {
          orgName = String(parsed.name);
          return send(200, { id: url.pathname.split('/').pop(), name: orgName });
        }
        if (url.pathname === '/organizations') {
          const id = `org_01FAKE${String(organizations.length + 1).padStart(6, '0')}`;
          organizations.push(id);
          return send(201, { id, name: parsed.name });
        }
        if (url.pathname === '/user_management/organization_memberships' && req.method === 'POST') return send(201, { id: 'om_01', role: { slug: parsed.role_slug } });
        if (url.pathname.startsWith('/user_management/organization_memberships/') && req.method === 'PUT') {
          const found = members.find((m) => m.id === url.pathname.split('/').pop());
          if (found === undefined) return send(404, { message: 'no such membership' });
          found.role = String(parsed.role_slug);
          return send(200, { id: found.id, role: { slug: found.role } });
        }
        if (url.pathname === '/user_management/invitations') {
          const made = { id: `invitation_${String(invitations.length + 1)}`, email: String(parsed.email), state: 'pending', role_slug: String(parsed.role_slug) };
          invitations.push(made);
          return send(201, { ...made, expires_at: '2026-09-26T00:00:00.000Z' });
        }
        if (url.pathname.endsWith('/revoke') && url.pathname.startsWith('/user_management/invitations/')) {
          const found = invitations.find((i) => i.id === url.pathname.split('/').at(-2));
          if (found !== undefined) found.state = 'revoked';
          return send(found === undefined ? 404 : 200, {});
        }
        if (url.pathname.startsWith('/organizations/')) return send(200, { id: url.pathname.slice('/organizations/'.length), name: 'Stage Labs' });
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
    enabled,
    members,
    invitations,
    outage,
    selection,
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
