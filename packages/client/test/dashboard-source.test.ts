import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { accountScopeIdentity, activeAccount, clearAccount } from '../src/auth/account.js';
import { setCurrentServer } from '../src/auth/daemon.js';
import { AuthError, callBearer, ForbiddenError, NotFoundError, StoppedError } from '../src/api/client.js';
import { dashboardKey, emptyReading, type DashboardRow } from '../src/api/dashboard.js';
import { DASHBOARD_SINCE, dashboardSource } from '../src/api/dashboard-source.js';
import { apiBase, configurePlatform, location, memoryKeyValue } from '../src/platform.js';
import { installTestAccount, testToken } from './account-fixture.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const API = 'https://api.example.invalid';
const originalBase = apiBase();
const originalLocation = location();
const realTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timerHost: {
  setTimeout: (callback: () => void, ms?: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer?: ReturnType<typeof setTimeout>) => void;
} = globalThis;
const networkHost: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } = globalThis;
const timers = new Map<ReturnType<typeof setTimeout>, { run: () => void; ms: number | undefined }>();
const seen: Request[] = [];
let answer: (request: Request) => Promise<Response>;
let restore = (): void => undefined;
const flush = async (): Promise<void> => { for (let at = 0; at < 60; at += 1) await Promise.resolve(); };
const json = (body: unknown, status = 200): Promise<Response> => Promise.resolve(Response.json(body, { status }));
const mode = (owner = 'org-a') => ({ mode: 'local', owner, version: DASHBOARD_SINCE });
const signal = (): AbortSignal => new AbortController().signal;
const source = () => dashboardSource(accountScopeIdentity(), () => true);

function row(organization = 'org-a', host = 'one.example.invalid'): DashboardRow {
  const agent = { id: 'same-id', host, name: 'Same name', slug: null, avatar: null };
  return {
    key: dashboardKey(organization, agent), agent, organization: { id: organization, name: organization, slug: null, role: 'member', agents: [agent] },
    session: emptyReading(), model: emptyReading(),
  };
}

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue(), apiBase: API,
    location: { hash: () => '#/unrelated.example.invalid/model', search: () => '', origin: () => API, replace: () => undefined, push: () => undefined, clearSearch: () => undefined },
  });
  clearAccount(); installTestAccount({ org_id: 'org-a', role: 'member' });
  setCurrentServer({ id: 'unrelated', host: 'selected.example.invalid' });
  seen.length = 0;
  answer = (request) => Promise.reject(new Error(`Unexpected mocked request: ${request.url}`));
  const fetcher = spyOn(networkHost, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    return answer(request);
  });
  const clock = spyOn(Date, 'now').mockReturnValue(NOW);
  const schedule = spyOn(timerHost, 'setTimeout').mockImplementation((callback, ms) => {
    const timer = realTimeout(() => undefined, 2 ** 30);
    timer.unref(); timers.set(timer, { run: () => callback(), ms });
    return timer;
  });
  const cancel = spyOn(timerHost, 'clearTimeout').mockImplementation((timer) => {
    if (timer !== undefined && typeof timer !== 'number') timers.delete(timer);
    realClearTimeout(timer);
  });
  restore = () => { fetcher.mockRestore(); clock.mockRestore(); schedule.mockRestore(); cancel.mockRestore(); };
});
afterEach(() => {
  clearAccount(); setCurrentServer(null);
  configurePlatform({ apiBase: originalBase, location: originalLocation, kv: memoryKeyValue(), tabKv: memoryKeyValue() });
  for (const timer of timers.keys()) realClearTimeout(timer);
  timers.clear(); restore();
});

describe('explicit dashboard bearer calls', () => {
  test('uses the provided bearer while signed out or with an expired unrelated global token', async () => {
    answer = () => json({ ok: true });
    clearAccount();
    expect(await callBearer({ method: 'GET', base: 'https://one.example.invalid', path: '/api/model/snapshot' }, 'explicit')).toEqual({ ok: true });
    installTestAccount({ org_id: 'other', exp: 1 });
    expect(await callBearer({ method: 'GET', base: 'https://two.example.invalid', path: '/api/claude/session/snapshot' }, 'other-explicit')).toEqual({ ok: true });
    expect(seen.map((request) => [request.url, request.headers.get('authorization'), request.redirect])).toEqual([
      ['https://one.example.invalid/api/model/snapshot', 'Bearer explicit', 'error'],
      ['https://two.example.invalid/api/claude/session/snapshot', 'Bearer other-explicit', 'error'],
    ]);
  });

  test.each([
    [401, AuthError], [403, ForbiddenError], [404, NotFoundError], [503, StoppedError],
  ])('status %s is typed without global refresh or retry', async (status, error) => {
    const account = activeAccount();
    answer = () => json({ error: 'refused', stopped: true }, status);
    await expect(callBearer({ method: 'GET', base: 'https://one.example.invalid/api/model/snapshot' }, 'org-b-token')).rejects.toBeInstanceOf(error);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer org-b-token');
    expect(activeAccount()).toBe(account);
  });

  test('forces redirect refusal even when its caller asks to follow', async () => {
    answer = (request) => {
      expect(request.redirect).toBe('error');
      return Promise.reject(new TypeError('redirect refused'));
    };
    await expect(callBearer({ method: 'GET', base: 'https://one.example.invalid/api/model/snapshot', redirect: 'follow' }, 'explicit')).rejects.toThrow('Failed to reach Metro');
    expect(seen).toHaveLength(1);
  });

  test('checks the account before sending and after an in-flight answer, including errors', async () => {
    let current = false;
    const checkAccount = (): void => { if (!current) throw new AuthError('scope changed'); };
    const init = { method: 'GET' as const, base: 'https://one.example.invalid/api/model/snapshot', checkAccount };
    await expect(callBearer(init, 'explicit')).rejects.toThrow('scope changed');
    expect(seen).toHaveLength(0);
    current = true;
    const pending = Promise.withResolvers<Response>();
    answer = () => pending.promise;
    const result = callBearer(init, 'explicit');
    current = false; pending.resolve(Response.json({ error: 'old response' }, { status: 403 }));
    await expect(result).rejects.toThrow('scope changed');
    expect(seen).toHaveLength(1);
  });
});

describe('passive dashboard network source', () => {
  test('lists membership and reads exact row hosts with exact organization bearers, never the selected daemon', async () => {
    const first = row(); const second = row('org-b', 'two.example.invalid');
    answer = (request) => {
      const url = new URL(request.url);
      if (request.url === `${API}/api/auth/organizations`) return json({ organizations: [first.organization, second.organization] });
      if (url.pathname === '/api/mode') return json(mode(url.hostname === 'one.example.invalid' ? 'org-a' : 'org-b'));
      if (url.pathname === '/api/claude/session/snapshot') return json({ running: true, runner: 'cli' });
      if (url.pathname === '/api/model/snapshot') return json({ connections: [] });
      throw new Error(`Unexpected endpoint ${request.url}`);
    };
    const network = source();
    expect(await network.organizations(signal())).toEqual([first.organization, second.organization]);
    await Promise.all([network.session(first, 'token-a', signal()), network.model(first, 'token-a', signal()),
      network.session(second, 'token-b', signal()), network.model(second, 'token-b', signal())]);
    expect(seen.map((request) => [request.url, request.headers.get('authorization')])).toEqual([
      [`${API}/api/auth/organizations`, `Bearer ${activeAccount()?.accessToken}`],
      ['https://one.example.invalid/api/mode', null], ['https://two.example.invalid/api/mode', null],
      ['https://one.example.invalid/api/claude/session/snapshot', 'Bearer token-a'], ['https://one.example.invalid/api/model/snapshot', 'Bearer token-a'],
      ['https://two.example.invalid/api/claude/session/snapshot', 'Bearer token-b'], ['https://two.example.invalid/api/model/snapshot', 'Bearer token-b'],
    ]);
    expect(seen.every((request) => request.method === 'GET' && request.redirect === 'error')).toBe(true);
    expect(timers.size).toBe(0);
  });

  test.each([[401, 200], [401, 401], [403, 403]])('inventory refusal %s retries at most once after refresh, then returns %s', async (first, second) => {
    const original = activeAccount();
    if (original === null) throw new Error('missing source account');
    const fresh = testToken({ org_id: 'org-a', role: 'member', iat: 123 });
    let lists = 0;
    answer = async (request) => {
      if (new URL(request.url).pathname === '/api/auth/refresh') {
        expect(await request.json()).toEqual({ refreshToken: 'rt_test' });
        return Response.json({ ...original, accessToken: fresh, refreshToken: 'rt-refreshed' });
      }
      lists += 1;
      return Response.json({ organizations: [], error: 'refused' }, { status: lists === 1 ? first : second });
    };
    const network = source();
    if (second === 200) expect(await network.organizations(signal())).toEqual([]);
    else await expect(network.organizations(signal())).rejects.toBeInstanceOf(second === 401 ? AuthError : ForbiddenError);
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(first === 401
      ? ['/api/auth/organizations', '/api/auth/refresh', '/api/auth/organizations'] : ['/api/auth/organizations']);
    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${original.accessToken}`);
    if (first === 401) expect(seen[2]?.headers.get('authorization')).toBe(`Bearer ${fresh}`);
    expect(network.current()).toBe(true);
  });

  test.each(['organizations', 'refresh'])('scope changes during inventory %s suppress refresh or retry', async (held) => {
    const original = activeAccount();
    const pending = Promise.withResolvers<Response>();
    answer = (request) => new URL(request.url).pathname === `/api/auth/${held}` ? pending.promise : json({ error: 'expired' }, 401);
    const network = source(); const result = network.organizations(signal()).catch((error: unknown) => error);
    await flush(); const replacement = installTestAccount({ org_id: 'other' });
    pending.resolve(Response.json(held === 'refresh' ? original : { error: 'expired' }, { status: held === 'refresh' ? 200 : 401 }));
    expect(await result).toBeInstanceOf(Error);
    expect(activeAccount()).toBe(replacement);
    expect(network.current()).toBe(false);
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(held === 'refresh'
      ? ['/api/auth/organizations', '/api/auth/refresh'] : ['/api/auth/organizations']);
  });

  test('member-level scoped tokens are cached by organization, restored to the source and explicitly forgotten', async () => {
    const scope = accountScopeIdentity();
    const destination = testToken({ org_id: 'org-b', role: 'member' });
    const original = activeAccount();
    if (original === null) throw new Error('missing source account');
    const bodies: unknown[] = [];
    answer = async (request) => {
      expect(request.url).toBe(`${API}/api/auth/switch`);
      const body: unknown = await request.json(); bodies.push(body);
      const returning = bodies.length % 2 === 0;
      return Response.json({ accessToken: returning ? original.accessToken : destination,
        refreshToken: returning ? 'rt-restored' : 'rt-destination', organization: returning ? 'org-a' : 'org-b', user: { id: 'user_1' } });
    };
    const network = source();
    expect(await network.token('org-a', signal())).toBe(original.accessToken);
    expect(await network.token('org-b', signal())).toBe(destination);
    expect(await network.token('org-b', signal())).toBe(destination);
    expect(bodies).toEqual([{ organization: 'org-b', refreshToken: 'rt_test' }, { organization: 'org-a', refreshToken: 'rt-destination' }]);
    expect(activeAccount()).toMatchObject({ organization: 'org-a', role: 'member', refreshToken: 'rt-restored' });
    expect(accountScopeIdentity()).toBe(scope);
    network.forgetToken('org-b');
    expect(await network.token('org-b', signal())).toBe(destination);
    expect(bodies).toHaveLength(4);
    expect(bodies[2]).toEqual({ organization: 'org-b', refreshToken: 'rt-restored' });
    expect(seen.every((request) => request.redirect === 'error')).toBe(true);
    const switches = answer;
    answer = (request) => new URL(request.url).pathname === '/api/auth/organizations' ? json({ organizations: [row().organization] }) : switches(request);
    await network.organizations(signal());
    expect(await network.token('org-b', signal())).toBe(destination);
    expect(bodies).toHaveLength(6);
    expect(bodies[4]).toEqual({ organization: 'org-b', refreshToken: 'rt-restored' });
  });

  test.each([
    [{ ...mode(), version: '0.1.0-beta.270' }, NotFoundError],
    [{ ...mode(), stopped: true }, StoppedError],
    [{ ...mode(), owner: 'org-other' }, ForbiddenError],
    [{ ...mode(), owner: null }, ForbiddenError],
  ])('unsupported, stopped or wrong-owner mode never receives a bearer: %j', async (body, error) => {
    answer = () => json(body);
    const network = source();
    const results = await Promise.allSettled([network.session(row(), 'token-a', signal()), network.model(row(), 'token-a', signal())]);
    expect(results.every((result) => result.status === 'rejected' && result.reason instanceof error)).toBe(true);
    expect(seen.map((request) => [request.url, request.headers.get('authorization')])).toEqual([['https://one.example.invalid/api/mode', null]]);
  });

  test('unknown versions try snapshot endpoints only and never fall back to active APIs after 404', async () => {
    answer = (request) => new URL(request.url).pathname === '/api/mode' ? json({ ...mode(), version: null }) : json({ error: 'unsupported' }, 404);
    const network = source();
    await expect(network.session(row(), 'explicit', signal())).rejects.toBeInstanceOf(NotFoundError);
    await expect(network.model(row(), 'explicit', signal())).rejects.toBeInstanceOf(NotFoundError);
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(['/api/mode', '/api/claude/session/snapshot', '/api/model/snapshot']);
  });

  test('public mode never grants authentication and 401 snapshots do not refresh global credentials', async () => {
    const account = activeAccount();
    answer = (request) => new URL(request.url).pathname === '/api/mode' ? json(mode()) : json({ error: 'not authorized' }, 401);
    await expect(source().model(row(), 'wrong-token', signal())).rejects.toBeInstanceOf(AuthError);
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(['/api/mode', '/api/model/snapshot']);
    expect(activeAccount()).toBe(account);
  });

  test('mode is deduplicated per exact row but revalidated on a later poll', async () => {
    answer = (request) => new URL(request.url).pathname === '/api/mode' ? json(mode()) : json({ connections: [] });
    const network = source();
    await network.model(row(), 'explicit', signal());
    await network.model(row(), 'explicit', signal());
    const clock = spyOn(Date, 'now').mockReturnValue(NOW + 20_001);
    await network.model(row(), 'explicit', signal());
    clock.mockRestore();
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(['/api/mode', '/api/model/snapshot', '/api/model/snapshot', '/api/mode', '/api/model/snapshot']);
  });

  test('membership removal forgets cached ownership before any later bearer is sent', async () => {
    let owner = 'org-a';
    answer = (request) => new URL(request.url).pathname === '/api/auth/organizations' ? json({ organizations: [] })
      : new URL(request.url).pathname === '/api/mode' ? json(mode(owner)) : json({ connections: [] });
    const network = source();
    await network.model(row(), 'explicit', signal());
    owner = 'org-b'; await network.organizations(signal());
    await expect(network.model(row(), 'explicit', signal())).rejects.toBeInstanceOf(ForbiddenError);
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(['/api/mode', '/api/model/snapshot', '/api/auth/organizations', '/api/mode']);
    expect(seen.at(-1)?.headers.get('authorization')).toBeNull();
  });

  test.each(['one.example.invalid/path', 'one.example.invalid?query=1', 'one.example.invalid#fragment', 'user:secret@one.example.invalid', 'https://one.example.invalid'])('rejects an untrusted row host before sending: %s', async (host) => {
    await expect(source().model(row('org-a', host), 'explicit', signal())).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  test('a malformed inventory is an error while null and empty agent listings remain different', async () => {
    answer = () => json({ organizations: [{ id: 'unknown' }, { id: 'empty', agents: [] }] });
    expect((await source().organizations(signal())).map((org) => org.agents)).toEqual([null, []]);
    answer = () => json({ organizations: null });
    await expect(source().organizations(signal())).rejects.toThrow('unexpected response');
  });

  test('late mode answers cannot send a bearer after an account-scope change', async () => {
    const pending = Promise.withResolvers<Response>();
    answer = () => pending.promise;
    const network = source(); const result = network.model(row(), 'old-token', signal());
    clearAccount(); pending.resolve(Response.json(mode()));
    await expect(result).rejects.toBeInstanceOf(AuthError);
    expect(network.current()).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get('authorization')).toBeNull();
  });

  test('scope changes during snapshot or inventory requests discard even successful results', async () => {
    for (const endpoint of ['model', 'organizations'] as const) {
      installTestAccount({ org_id: 'org-a' });
      const pending = Promise.withResolvers<Response>();
      answer = (request) => new URL(request.url).pathname === '/api/mode' ? json(mode()) : pending.promise;
      const network = source();
      const result = endpoint === 'model' ? network.model(row(), 'old-token', signal()) : network.organizations(signal());
      await flush(); clearAccount();
      pending.resolve(Response.json(endpoint === 'model' ? { connections: [] } : { organizations: [] }));
      await expect(result).rejects.toBeInstanceOf(AuthError);
    }
  });

  test('closed views reject before any network work', async () => {
    const network = dashboardSource(accountScopeIdentity(), () => false);
    await expect(network.organizations(signal())).rejects.toBeInstanceOf(AuthError);
    await expect(network.model(row(), 'explicit', signal())).rejects.toBeInstanceOf(AuthError);
    await expect(network.token('org-a', signal())).rejects.toBeInstanceOf(AuthError);
    expect(seen).toHaveLength(0);
  });

  test.each(['mode', 'model', 'organizations'])('%s requests abort at their bounded deadline without waiting for a real clock', async (endpoint) => {
    answer = (request) => {
      if (endpoint === 'model' && new URL(request.url).pathname === '/api/mode') return json(mode());
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    };
    const network = source();
    const pending = endpoint === 'organizations' ? network.organizations(signal()) : network.model(row(), 'explicit', signal());
    const failure = pending.catch((error: unknown) => error);
    await flush();
    expect(timers.size).toBe(1);
    const timer = timers.values().next().value;
    expect(timer?.ms).toBe(8_000);
    timer?.run();
    expect(await failure).toBeInstanceOf(Error);
    expect(seen.at(-1)?.signal.aborted).toBe(true);
    expect(timers.size).toBe(0);
  });

  test('native-shaped signals without throwIfAborted support reads and cancellation', async () => {
    const original = globalThis.AbortController;
    globalThis.AbortController = class extends original {
      constructor() { super(); Object.defineProperty(this.signal, 'throwIfAborted', { value: undefined }); }
    };
    try {
      const network = source();
      answer = (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/api/auth/organizations') return json({ organizations: [] });
        if (path === '/api/mode') return json(mode());
        return json(path === '/api/model/snapshot' ? { connections: [] } : { running: true, runner: 'cli' });
      };
      expect(await network.token('org-a', signal())).toBe(activeAccount()?.accessToken ?? 'missing');
      expect(await network.organizations(signal())).toEqual([]);
      expect(await network.session(row(), 'explicit', signal())).toMatchObject({ running: true, runner: 'cli' });
      expect(await network.model(row(), 'explicit', signal())).toMatchObject({ connections: [] });
      answer = (request) => new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      const controller = new AbortController();
      expect(controller.signal.throwIfAborted).toBeUndefined();
      const pending = network.model(row(), 'explicit', controller.signal).catch((error: unknown) => error);
      await flush(); controller.abort();
      expect(await pending).toBeInstanceOf(Error);
      expect(seen.at(-1)?.signal.aborted).toBe(true);
      const count = seen.length;
      await expect(network.organizations(controller.signal)).rejects.toThrow();
      await expect(network.model(row(), 'explicit', controller.signal)).rejects.toThrow();
      expect(seen).toHaveLength(count);
    } finally {
      globalThis.AbortController = original;
    }
  });

  test('caller cancellation aborts an in-flight snapshot and a pre-aborted read sends nothing', async () => {
    answer = (request) => new URL(request.url).pathname === '/api/mode' ? json(mode()) : new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    });
    const controller = new AbortController(); const network = source();
    const pending = network.model(row(), 'explicit', controller.signal).catch((error: unknown) => error);
    await flush(); controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(seen.at(-1)?.signal.aborted).toBe(true);
    expect(timers.size).toBe(0);
    const count = seen.length;
    await expect(network.model(row(), 'explicit', controller.signal)).rejects.toThrow();
    expect(seen).toHaveLength(count);
  });
});
