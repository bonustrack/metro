import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleAuthApiRequest, type AuthApiDeps } from '../src/auth/routes.ts';
import { readWorkosConfig } from '../src/auth/workos.ts';
import { fakeWorkos, type FakeWorkos } from './workos-fake.ts';
import { memorySlugs } from './slug-fake.ts';
import { memoryUsers } from './users-fake.ts';

let workos: FakeWorkos;
let server: Server;
let base = '';

beforeAll(async () => {
  workos = await fakeWorkos();
  const env = { WORKOS_API_KEY: 'sk_test_fake', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_BASE: workos.base };
  const deps: AuthApiDeps = { config: () => readWorkosConfig(env), keys: new SigningKeys(workos.issuer.url), publicBase: () => base, slugs: memorySlugs(), users: memoryUsers() };
  server = createServer((req, res) => {
    if (handleAuthApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.close();
  await workos.close();
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('signing in with a code sent by email', () => {
  test('the code is sent through WorkOS, and a right code lands like any other sign-in', async () => {
    const sent = await post('/email/start', { email: ' Admin@Stage.box ' });
    expect(sent.status).toBe(200);
    expect(workos.calls.at(-1)).toMatchObject({ path: '/user_management/magic_auth', body: { email: 'admin@stage.box' } });
    const verified = await post('/email/verify', { email: 'admin@stage.box', code: '123456' });
    expect(verified.status).toBe(200);
    const { hash } = (await verified.json()) as { hash: string };
    const handoff = /^#\/auth\/(.+)$/.exec(hash)?.[1] ?? '';
    const exchanged = await post('/exchange', { code: handoff });
    expect(exchanged.status).toBe(200);
    expect(((await exchanged.json()) as { user: { email: string } }).user.email).toBe('admin@stage.box');
  });

  test('an invitation rides along to WorkOS on both steps', async () => {
    const invitation = 'inv_token_abcdef';
    expect((await post('/email/start', { email: 'bob@stage.box', invitation })).status).toBe(200);
    expect(workos.calls.at(-1)?.body).toMatchObject({ email: 'bob@stage.box', invitation_token: invitation });
    await post('/email/verify', { email: 'bob@stage.box', code: '123456', invitation });
    expect(workos.calls.at(-1)?.body).toMatchObject({ grant_type: 'urn:workos:oauth:grant-type:magic-auth:code', email: 'bob@stage.box', invitation_token: invitation });
    expect((await post('/email/start', { email: 'bob@stage.box', invitation: 'bad token!' })).status).toBe(400);
  });

  test('a wrong code, a bad address and too many codes are refused with a sentence', async () => {
    const wrong = await post('/email/verify', { email: 'admin@stage.box', code: '000000' });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(await wrong.json())).toContain('not right or has expired');
    expect((await post('/email/verify', { email: 'admin@stage.box', code: 'abc' })).status).toBe(400);
    expect((await post('/email/start', { email: 'not-an-address' })).status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post('/email/start', { email: 'carol@example.com' })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
