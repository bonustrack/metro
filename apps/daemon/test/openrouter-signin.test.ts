import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { handleModelRequest, type ModelApiDeps } from '../src/gateway/model-api.ts';
import type { ModelConfig } from '../src/gateway/model-config.ts';
import { auth, TEST_OWNER } from './identity-helper.ts';

let server: Server;
let base = '';
let token = '';
let deps: ModelApiDeps;
let saved: ModelConfig;
let exchanges = 0;
const LOGIN = '/api/model/openrouter/login';
const CALLBACK = '/api/model/openrouter/callback';

beforeAll(async () => {
  token = await auth(TEST_OWNER, 'member');
  server = createServer((req, res) => { if (!handleModelRequest(req, res, deps)) res.writeHead(404).end(); });
  const port = 10000 + Math.floor(Math.random() * 20000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String(port)}`;
});

afterAll(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => {
  exchanges = 0;
  saved = { version: 2, route: '', connections: [] };
  deps = {
    read: () => saved,
    write: (next) => { saved = next; },
    owner: () => TEST_OWNER,
    openrouterPublicBase: () => 'https://configured.example',
    fetchImpl: (() => { exchanges += 1; return Promise.resolve(Response.json({ key: 'sk-or-fake-only' })); }) as unknown as typeof fetch,
  };
});

const request = (path: string, method = 'GET', authorization = token): Promise<Response> => fetch(`${base}${path}`, { method, headers: { authorization, host: 'untrusted.example' }, redirect: 'manual' });
const started = async (): Promise<{ id: string; url: string }> => (await request(LOGIN, 'POST')).json() as Promise<{ id: string; url: string }>;

describe('OpenRouter model routes', () => {
  test('begin/status/cancel require owner bearer auth, never an agent key', async () => {
    const attempt = await started();
    for (const [path, method] of [[LOGIN, 'POST'], [`${LOGIN}/${attempt.id}`, 'GET'], [`${LOGIN}/${attempt.id}`, 'DELETE']]) {
      expect((await request(path ?? '', method, '')).status).toBe(401);
      expect((await request(path ?? '', method, 'Bearer mk_fake-agent-key')).status).toBe(401);
    }
    expect((await request(LOGIN, 'POST', await auth('org_01OTHEROWNER00000'))).status).toBe(403);
    expect((await request(`${LOGIN}/${attempt.id}`, 'GET', await auth('org_01OTHEROWNER00000'))).status).toBe(403);
    expect(exchanges).toBe(0);
  });

  test('member can start, poll, cancel and never receives a credential', async () => {
    const attempt = await started();
    expect(new URL(attempt.url).searchParams.get('callback_url')).toBe(`https://configured.example${CALLBACK}`);
    expect(await (await request(`${LOGIN}/${attempt.id}`)).json()).toEqual({ status: 'pending' });
    const cancelled = await request(`${LOGIN}/${attempt.id}`, 'DELETE');
    expect(cancelled.headers.get('cache-control')).toBe('no-store');
    expect(await cancelled.json()).toEqual({ status: 'failed', error: 'OpenRouter sign-in cancelled.' });
    expect(exchanges).toBe(0);
    expect(saved.connections).toHaveLength(0);
  });

  test('only GET callback is public and strips code and state before showing a generic page', async () => {
    const attempt = await started();
    const state = new URL(attempt.url).searchParams.get('state') ?? '';
    expect((await request(`${CALLBACK}?code=fake-code&state=${state}`, 'POST', '')).status).toBe(405);
    const response = await request(`${CALLBACK}?code=fake-code&state=${state}`, 'GET', '');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(CALLBACK);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await response.text()).toBe('');
    expect(exchanges).toBe(1);
    expect(saved.connections[0]?.apiKey).toBe('sk-or-fake-only');
    const body = await (await request(`${LOGIN}/${attempt.id}`)).text();
    expect(JSON.parse(body)).toEqual({ status: 'done', connection: saved.connections[0]?.id });
    expect(body).not.toContain('sk-or-fake-only');
    const clean = await request(CALLBACK, 'GET', '');
    expect(clean.status).toBe(200);
    const page = await clean.text();
    expect(page).toContain('Return to Metro');
    for (const secret of [state, 'fake-code', 'sk-or-fake-only']) expect(page).not.toContain(secret);
    await request(`${CALLBACK}?code=fake-code&state=${state}`, 'GET', '');
    expect(exchanges).toBe(1);
  });

  test('uncorrelated denial and bad state redirect cleanly without exchanging or changing attempts', async () => {
    const attempt = await started();
    for (const query of ['error=access_denied', 'code=fake&state=wrong', 'state=wrong&error=<script>']) {
      const res = await request(`${CALLBACK}?${query}`, 'GET', '');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(CALLBACK);
    }
    expect(await (await request(`${LOGIN}/${attempt.id}`)).json()).toEqual({ status: 'pending' });
    expect(exchanges).toBe(0);
  });

  test('a missing configured origin offers manual entry and methods stay narrow', async () => {
    deps.openrouterPublicBase = () => null;
    const res = await request(LOGIN, 'POST');
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Use an API key');
    expect((await request(LOGIN, 'GET')).status).toBe(405);
    expect((await request(`${LOGIN}/${'a'.repeat(32)}`, 'POST')).status).toBe(405);
    expect((await request(`${LOGIN}/${'a'.repeat(32)}`, 'GET')).status).toBe(410);
    expect(exchanges).toBe(0);
  });
});
