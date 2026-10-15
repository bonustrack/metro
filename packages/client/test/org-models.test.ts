import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import {
  addOrgModel,
  beginOrgCodexDevice,
  beginOrgCodexLogin,
  beginOrgOpenRouterLogin,
  clearModelRoute,
  deleteOrgModel,
  fetchOrgModelList,
  fetchOrgModels,
  finishOrgCodexLogin,
  pollOrgCodexDevice,
  readOpenRouterReturn,
  setModelRoute,
  toOrgModels,
  updateOrgModel,
} from '../src/api/org-models.js';
import { installTestAccount } from './account-fixture.js';

const BASE = 'https://api.metro.box/api/models';
const realFetch = globalThis.fetch;

interface Seen {
  url: string;
  method: string | undefined;
  body: unknown;
}

let calls: Seen[] = [];

function serve(body: unknown, status = 200): void {
  calls = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return Promise.resolve(Response.json(body, { status }));
  }) as unknown as typeof fetch;
}

const ROUTE = { primary: { connection: 'orA00000001', model: 'openai/gpt-5.2' }, fallbacks: [{ connection: 'cdx00000001', model: 'gpt-6-astra' }] };
const LIST = {
  connections: [
    { id: 'orA00000001', provider: 'openrouter', label: 'OpenRouter', model: '', region: '', zdr: true, account: { email: null, plan: null, method: null }, signedOut: false, createdAt: '2026-10-15T08:00:00.000Z' },
    { id: 'cdx00000001', provider: 'codex', label: 'ChatGPT', model: 'gpt-6-astra', account: { email: 'less@x', plan: null, method: 'code' }, signedOut: true },
    { id: 'gem00000001', provider: 'gemini', label: 'Gemini' },
  ],
  default: ROUTE,
  agents: { agentA00001: { primary: { connection: 'local:session', model: '' }, fallbacks: [] }, broken00001: { fallbacks: [] } },
};

beforeAll(() => {
  configurePlatform({ kv: memoryKeyValue() });
  installTestAccount();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  configurePlatform({ signInReturn: null });
});

afterAll(() => {
  clearAccount();
});

describe('the organization models client', () => {
  test('reads connections, the default route and the overrides, with no secret and no Gemini', async () => {
    serve(LIST);
    const list = await fetchOrgModels();
    expect(calls).toEqual([{ url: BASE, method: 'GET', body: undefined }]);
    expect(list.connections.map((c) => c.id)).toEqual(['orA00000001', 'cdx00000001']);
    expect(list.connections[0]).toMatchObject({ provider: 'openrouter', hasKey: true, zdr: true, createdAt: '2026-10-15T08:00:00.000Z' });
    expect(list.connections[1]).toMatchObject({ signedOut: true, account: 'less@x', method: 'code', hasKey: false });
    expect(list.default).toEqual(ROUTE);
    expect(Object.keys(list.agents)).toEqual(['agentA00001']);
    expect(list.admin).toBe(true);
    expect(toOrgModels({ connections: [], default: null, admin: false }).admin).toBe(false);
    expect(() => toOrgModels({ default: null })).toThrow(/unexpected/);
  });

  test('a member account is not an admin when the api does not say', () => {
    installTestAccount({ role: 'member' });
    expect(toOrgModels({ connections: [] }).admin).toBe(false);
    installTestAccount();
  });

  test('adds by key, patches, removes, and answers the new id', async () => {
    serve({ connection: { id: 'new00000001' } }, 201);
    expect(await addOrgModel({ provider: 'anthropic', label: ' Claude key ', apiKey: ' sk-ant ' })).toBe('new00000001');
    expect(calls[0]).toEqual({ url: BASE, method: 'POST', body: { provider: 'anthropic', label: 'Claude key', apiKey: 'sk-ant' } });
    serve({});
    await updateOrgModel('orA00000001', { zdr: false, label: 'Work' });
    expect(calls[0]).toEqual({ url: `${BASE}/orA00000001`, method: 'PATCH', body: { zdr: false, label: 'Work' } });
    serve({});
    await deleteOrgModel('orA00000001');
    expect(calls[0]).toEqual({ url: `${BASE}/orA00000001`, method: 'DELETE', body: undefined });
    serve({});
    expect(await addOrgModel({ provider: 'bedrock', label: 'AWS', apiKey: 'k', region: 'eu-central-1' })).toBeNull();
  });

  test('routes are a PUT with the agent or null, and an override is removed by agent', async () => {
    serve({});
    await setModelRoute(null, ROUTE);
    await setModelRoute('agentA00001', ROUTE);
    await clearModelRoute('agentA00001');
    await clearModelRoute(null);
    expect(calls).toEqual([
      { url: `${BASE}/route`, method: 'PUT', body: { agent: null, ...ROUTE } },
      { url: `${BASE}/route`, method: 'PUT', body: { agent: 'agentA00001', ...ROUTE } },
      { url: `${BASE}/route?agent=agentA00001`, method: 'DELETE', body: undefined },
      { url: `${BASE}/route`, method: 'DELETE', body: undefined },
    ]);
  });

  test('the model list of a connection comes from the api', async () => {
    serve({ models: [{ id: 'openai/gpt-5.2', name: 'OpenAI: GPT-5.2', price: { prompt: 0.000001, completion: 0.000008 }, zdr: true }] });
    expect(await fetchOrgModelList('orA00000001')).toEqual([{ id: 'openai/gpt-5.2', name: 'OpenAI: GPT-5.2', price: '$1 in · $8 out per 1M', zdr: true }]);
    expect(calls[0]?.url).toBe(`${BASE}/orA00000001/models`);
  });

  test('the Codex sign-ins name the connection to sign in again, and refuse an address that is not https', async () => {
    serve({ authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?client_id=x' });
    expect(await beginOrgCodexLogin('cdx00000001')).toBe('https://auth.openai.com/api/accounts/authorize?client_id=x');
    expect(calls[0]).toEqual({ url: `${BASE}/codex/login`, method: 'POST', body: { connection: 'cdx00000001' } });
    serve({ authorizeUrl: 'javascript:alert(1)' });
    await expect(beginOrgCodexLogin()).rejects.toThrow('will not open');
    expect(calls[0]?.body).toEqual({});
    serve({});
    await finishOrgCodexLogin(' http://127.0.0.1:1455/auth/callback?code=a&state=b ');
    expect(calls[0]).toEqual({ url: `${BASE}/codex/callback`, method: 'POST', body: { url: 'http://127.0.0.1:1455/auth/callback?code=a&state=b' } });
  });

  test('the Codex code sign-in reads both spellings and polls until done or failed', async () => {
    serve({ id: 'dev_1', user_code: 'ABCD-EFGH', verify_url: 'https://auth.openai.com/codex/device', interval: 0 });
    expect(await beginOrgCodexDevice()).toEqual({ id: 'dev_1', userCode: 'ABCD-EFGH', verifyUrl: 'https://auth.openai.com/codex/device', interval: 5 });
    serve({ id: 'dev_2', userCode: 'WXYZ', verifyUrl: 'https://auth.openai.com/codex/device', interval: 3 });
    expect((await beginOrgCodexDevice('cdx00000001')).interval).toBe(3);
    expect(calls[0]?.body).toEqual({ connection: 'cdx00000001' });
    serve({ status: 'pending' });
    expect(await pollOrgCodexDevice('dev_2')).toEqual({ status: 'pending' });
    expect(calls[0]?.url).toBe(`${BASE}/codex/device/dev_2`);
    serve({ status: 'done' });
    expect(await pollOrgCodexDevice('dev_2')).toEqual({ status: 'done' });
    serve({ status: 'failed' });
    expect(await pollOrgCodexDevice('dev_2')).toEqual({ status: 'failed', error: 'The sign-in did not finish.' });
  });

  test('the OpenRouter sign-in opens only openrouter.ai', async () => {
    serve({ authorizeUrl: 'https://openrouter.ai/auth?callback_url=https://api.metro.box/api/models/openrouter/callback' });
    expect(await beginOrgOpenRouterLogin()).toContain('https://openrouter.ai/auth');
    expect(calls[0]).toEqual({ url: `${BASE}/openrouter/login`, method: 'POST', body: {} });
    serve({ authorizeUrl: 'https://evil.example/auth' });
    await expect(beginOrgOpenRouterLogin('orA00000001')).rejects.toThrow('will not open');
    configurePlatform({ signInReturn: () => 'https://metro.box/' });
    serve({ authorizeUrl: 'https://openrouter.ai/auth?x=1' });
    await beginOrgOpenRouterLogin('orA00000001');
    expect(calls[0]?.body).toEqual({ connection: 'orA00000001', returnTo: 'https://metro.box/' });
  });

  test('the OpenRouter return on the Models page is read once and taken out of the address', () => {
    expect(readOpenRouterReturn('#/org_01TESTOWNER000000/organization/models?openrouter=orA00000001')).toEqual({ result: { kind: 'done', connection: 'orA00000001' }, hash: '#/org_01TESTOWNER000000/organization/models' });
    expect(readOpenRouterReturn('#/organization/models?openrouter_error=Access%20denied&x=1')).toEqual({ result: { kind: 'error', error: 'Access denied' }, hash: '#/organization/models?x=1' });
    expect(readOpenRouterReturn('#/organization/models')).toEqual({ result: null, hash: '#/organization/models' });
    expect(readOpenRouterReturn('#/agent/model?openrouter=x')).toEqual({ result: null, hash: '#/agent/model?openrouter=x' });
  });
});
