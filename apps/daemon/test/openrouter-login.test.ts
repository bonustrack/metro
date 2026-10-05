import { describe, expect, test, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { OpenRouterLogins, OPENROUTER_CALLBACK } from '../src/gateway/openrouter-login.ts';
import { publicModelConfig, type ModelConfig } from '../src/gateway/model-config.ts';
import { makeConnection } from './model-fixture.ts';

const OWNER = 'org_openrouter_test';
const KEY = 'sk-or-fake-generated-key';
const blank = (): ModelConfig => ({ version: 2, route: '', connections: [] });

function fixture(initial = blank(), response: () => Promise<Response> = () => Promise.resolve(Response.json({ key: KEY }))) {
  let cfg = initial;
  let owner = OWNER;
  let base: string | null = 'https://box.example';
  let now = 1000;
  const fetchImpl = mock((_url: string | URL | Request, _init?: RequestInit) => response());
  const write = mock((next: ModelConfig) => { cfg = next; });
  const login = new OpenRouterLogins({ store: { read: () => cfg, write }, owner: () => owner, publicBase: () => base, now: () => now, fetchImpl: fetchImpl as unknown as typeof fetch });
  return { login, fetchImpl, write, config: () => cfg, replace: (next: ModelConfig) => { cfg = next; }, owner: (next: string) => { owner = next; }, base: (next: string | null) => { base = next; }, time: (next: number) => { now = next; } };
}

const returned = (url: string): URLSearchParams => new URLSearchParams({ state: new URL(url).searchParams.get('state') ?? '', code: 'fake-authorization-code' });
const existing = (): ModelConfig => ({ version: 2, route: 'cn-openrouter', connections: [makeConnection('openrouter', { apiKey: 'old-key', model: 'openai/test', label: 'My account', zdr: true }), makeConnection('anthropic', { apiKey: 'other-key' })], fallbacks: [{ connection: 'cn-openrouter', model: 'other/model' }] });

describe('OpenRouter key provisioning', () => {
  test('S256 state and exchange keep the key on the daemon and leave model selection to the person', async () => {
    const f = fixture();
    const started = f.login.begin(OWNER, '');
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('callback_url')).toBe(`https://box.example${OPENROUTER_CALLBACK}`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('key_label')).toBe('Metro');
    expect(url.searchParams.get('state')).not.toBe(started.id);
    expect(started.expiresAt).toBe(601000);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.login.status(OWNER, started.id)).toEqual({ status: 'pending' });
    await f.login.complete(returned(started.url));
    const [endpoint, init] = f.fetchImpl.mock.calls[0] ?? [];
    expect(endpoint).toBe('https://openrouter.ai/api/v1/auth/keys');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    const body = JSON.parse(String(init?.body)) as { code: string; code_verifier: string; code_challenge_method: string };
    expect(body.code).toBe('fake-authorization-code');
    expect(body.code_challenge_method).toBe('S256');
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    const saved = f.config().connections[0];
    expect(saved?.apiKey).toBe(KEY);
    expect(saved?.model).toBe('');
    expect(f.login.status(OWNER, started.id)).toEqual({ status: 'done', connection: saved?.id });
    expect(JSON.stringify(f.login.status(OWNER, started.id))).not.toContain(KEY);
    expect(JSON.stringify(publicModelConfig(f.config()))).not.toContain(KEY);
    await expect(f.login.complete(returned(started.url))).rejects.toThrow('expired');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.login.cancel(OWNER, started.id)).toEqual({ status: 'done', connection: saved?.id });
  });

  test('reconnection preserves label, model, ZDR, route, fallback order and other connections', async () => {
    const before = existing();
    const f = fixture(before);
    const started = f.login.begin(OWNER, 'cn-openrouter');
    await f.login.complete(returned(started.url));
    expect(f.config()).toEqual({ ...before, connections: before.connections.map((c) => c.provider === 'openrouter' ? { ...c, apiKey: KEY } : c) });
  });

  test.each([null, '', 'http://box.example', 'https://user:pass@box.example', 'https://box.example/path', 'https://box.example/?x=y', 'https://box.example/#x'])('refuses a missing or unsafe callback origin %s', (base) => {
    const f = fixture();
    f.base(base);
    expect(() => f.login.begin(OWNER, '')).toThrow('public HTTPS');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  test('unknown, missing and expired state never exchange or save', async () => {
    const f = fixture();
    const started = f.login.begin(OWNER, '');
    await expect(f.login.complete(new URLSearchParams('code=fake'))).rejects.toThrow('expired');
    await expect(f.login.complete(new URLSearchParams('code=fake&state=wrong'))).rejects.toThrow('expired');
    expect(f.login.status(OWNER, started.id)).toEqual({ status: 'pending' });
    f.time(started.expiresAt);
    await expect(f.login.complete(returned(started.url))).rejects.toThrow('expired');
    expect(() => f.login.status(OWNER, started.id)).toThrow('expired');
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  test.each(['missing', 'duplicate-code', 'duplicate-state', 'denied', 'oversize'])('invalid callback %s consumes the state without exchange', async (kind) => {
    const f = fixture();
    const started = f.login.begin(OWNER, '');
    const params = returned(started.url);
    if (kind === 'missing') params.delete('code');
    if (kind === 'duplicate-code') params.append('code', 'another');
    if (kind === 'duplicate-state') params.append('state', 'another');
    if (kind === 'denied') params.set('error', 'upstream-secret-message');
    if (kind === 'oversize') params.set('code', 'x'.repeat(4097));
    await expect(f.login.complete(params)).rejects.toThrow('did not approve');
    await expect(f.login.complete(returned(started.url))).rejects.toThrow('expired');
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(f.login.status(OWNER, started.id))).not.toContain('upstream-secret-message');
  });

  test('denial without state cannot affect a pending attempt', async () => {
    const f = fixture();
    const started = f.login.begin(OWNER, '');
    await expect(f.login.complete(new URLSearchParams('error=access_denied'))).rejects.toThrow('expired');
    expect(f.login.status(OWNER, started.id)).toEqual({ status: 'pending' });
    f.login.cancel(OWNER, started.id);
    await expect(f.login.complete(returned(started.url))).rejects.toThrow('expired');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  test.each(['empty', 'oversize', 'bad-json', 'redirect', 'refused', 'network'])('upstream failure %s is sanitized and keeps old credentials', async (kind) => {
    const f = fixture(existing(), () => {
      if (kind === 'network') return Promise.reject(new Error(KEY));
      if (kind === 'bad-json') return Promise.resolve(new Response(KEY));
      if (kind === 'redirect') return Promise.resolve(new Response(KEY, { status: 302, headers: { location: 'https://untrusted.example' } }));
      if (kind === 'refused') return Promise.resolve(new Response(KEY, { status: 400 }));
      return Promise.resolve(Response.json({ key: kind === 'empty' ? '' : 'x'.repeat(513) }));
    });
    const started = f.login.begin(OWNER, 'cn-openrouter');
    await expect(f.login.complete(returned(started.url))).rejects.toThrow('did not finish');
    expect(f.config()).toEqual(existing());
    expect(f.write).not.toHaveBeenCalled();
    expect(JSON.stringify(f.login.status(OWNER, started.id))).not.toContain(KEY);
  });

  test('attempts are owner-bound and targets must exist and match the provider', async () => {
    const f = fixture(existing());
    expect(() => f.login.begin('org_other', '')).toThrow('organization');
    expect(() => f.login.begin(OWNER, 'gone')).toThrow('no longer exists');
    expect(() => f.login.begin(OWNER, 'cn-anthropic')).toThrow('no longer exists');
    const started = f.login.begin(OWNER, 'cn-openrouter');
    expect(() => f.login.status('org_other', started.id)).toThrow('organization');
    expect(() => f.login.cancel('org_other', started.id)).toThrow('organization');
    f.owner('org_other');
    expect(() => f.login.status('org_other', started.id)).toThrow('expired');
    await expect(f.login.complete(returned(started.url))).rejects.toThrow('organization');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  test.each(['cancel', 'owner', 'remove', 'replace-key', 'expire'])('a pending exchange cannot save after %s', async (kind) => {
    const deferred = Promise.withResolvers<Response>();
    const f = fixture(existing(), () => deferred.promise);
    const started = f.login.begin(OWNER, 'cn-openrouter');
    const completing = f.login.complete(returned(started.url));
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    if (kind === 'cancel') f.login.cancel(OWNER, started.id);
    if (kind === 'owner') f.owner('org_other');
    if (kind === 'remove') f.replace(blank());
    if (kind === 'replace-key') f.replace({ ...existing(), connections: [makeConnection('openrouter', { apiKey: 'manual-new-key' })] });
    if (kind === 'expire') f.time(started.expiresAt);
    deferred.resolve(Response.json({ key: KEY }));
    await expect(completing).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
    if (kind === 'cancel') expect(f.fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  test('concurrent model and fallback edits survive an exchange', async () => {
    const deferred = Promise.withResolvers<Response>();
    const f = fixture(existing(), () => deferred.promise);
    const started = f.login.begin(OWNER, 'cn-openrouter');
    const completing = f.login.complete(returned(started.url));
    const changed = { ...existing(), route: 'cn-anthropic', fallbacks: [], connections: [makeConnection('openrouter', { apiKey: 'old-key', model: 'new/model', zdr: false, label: 'New name' }), makeConnection('anthropic')] };
    f.replace(changed);
    deferred.resolve(Response.json({ key: KEY }));
    await completing;
    expect(f.config()).toEqual({ ...changed, connections: changed.connections.map((c) => c.provider === 'openrouter' ? { ...c, apiKey: KEY } : c) });
  });

  test('bounded attempts expire and capacity is checked before upstream work', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.login.begin(OWNER, '');
    expect(() => f.login.begin(OWNER, '')).toThrow('Too many');
    f.time(601000);
    expect(f.login.begin(OWNER, '').id).toHaveLength(32);
    f.replace({ ...blank(), connections: Array.from({ length: 20 }, (_, i) => makeConnection('openrouter', { id: `cn-${String(i)}` })) });
    expect(() => f.login.begin(OWNER, '')).toThrow();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
