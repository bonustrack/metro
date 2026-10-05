import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { beginOpenRouterLogin, cancelOpenRouterLogin, OPENROUTER_LOGIN_SINCE, pollOpenRouterLogin } from '../src/api/openrouter-login.js';
import { olderThan } from '../src/api/version.js';
import { clearAccount, storeAccount } from '../src/auth/account.js';
import { setCurrentServer } from '../src/auth/daemon.js';
import { installTestAccount } from './account-fixture.js';

const started = { id: 'a'.repeat(32), url: 'https://openrouter.ai/auth?state=fake-state', expiresAt: Date.now() + 600000 };
let fetching = spyOn(globalThis, 'fetch');

beforeEach(() => {
  fetching = spyOn(globalThis, 'fetch');
  installTestAccount();
  setCurrentServer({ id: 'box00000001', host: 'original.example' });
  fetching.mockReset();
  fetching.mockResolvedValue(Response.json(started));
});
afterEach(() => { clearAccount(); setCurrentServer(null); fetching.mockRestore(); });

describe('OpenRouter client sign-in', () => {
  test('new and reconnect calls are scoped and answers contain only public fields', async () => {
    fetching.mockResolvedValue(Response.json({ ...started, key: 'must-not-leak' }));
    const login = await beginOpenRouterLogin('connection/a');
    expect(fetching.mock.calls[0]?.[0]).toBe('https://original.example/api/model/openrouter/login?connection=connection%2Fa');
    expect(fetching.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.stringify(login)).not.toContain('must-not-leak');
    fetching.mockResolvedValue(Response.json({ status: 'done', connection: 'new-connection', key: 'must-not-leak' }));
    expect(await pollOpenRouterLogin(login)).toEqual({ status: 'done', connection: 'new-connection' });
    expect(fetching.mock.calls[1]?.[0]).toBe(`https://original.example/api/model/openrouter/login/${started.id}`);
  });

  test.each(['http://openrouter.ai/auth', 'https://untrusted.example/auth', 'https://openrouter.ai/other', 'https://name:secret@openrouter.ai/auth', 'javascript:alert(1)'])('rejects unexpected authorization location %s', async (url) => {
    fetching.mockResolvedValue(Response.json({ ...started, url }));
    await expect(beginOpenRouterLogin()).rejects.toThrow('unexpected');
  });

  test('malformed begin and status responses are rejected', async () => {
    fetching.mockResolvedValue(Response.json({ ...started, id: 'bad' }));
    await expect(beginOpenRouterLogin()).rejects.toThrow('unexpected');
    fetching.mockResolvedValue(Response.json(started));
    const login = await beginOpenRouterLogin();
    fetching.mockResolvedValue(Response.json({ status: 'done' }));
    await expect(pollOpenRouterLogin(login)).rejects.toThrow('unexpected');
  });

  test('box switches stop polling but cancellation still targets the original box', async () => {
    const login = await beginOpenRouterLogin();
    setCurrentServer({ id: 'box00000002', host: 'other.example' });
    await expect(pollOpenRouterLogin(login)).rejects.toThrow('selected box changed');
    expect(fetching).toHaveBeenCalledTimes(1);
    fetching.mockResolvedValue(Response.json({ status: 'failed', error: 'Cancelled' }));
    expect(await cancelOpenRouterLogin(login)).toEqual({ status: 'failed', error: 'Cancelled' });
    expect(fetching.mock.calls[1]?.[0]).toBe(`https://original.example/api/model/openrouter/login/${started.id}`);
    expect(fetching.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  test('switching account or organization prevents polling and cancellation', async () => {
    const login = await beginOpenRouterLogin();
    const account = installTestAccount();
    storeAccount({ ...account, user: { ...account.user, id: 'another-user' } });
    await expect(pollOpenRouterLogin(login)).rejects.toThrow('account changed');
    await expect(cancelOpenRouterLogin(login)).rejects.toThrow('account changed');
    installTestAccount({ org_id: 'org_other' });
    await expect(cancelOpenRouterLogin(login)).rejects.toThrow('account changed');
    expect(fetching).toHaveBeenCalledTimes(1);
  });

  test('a box change during an async begin cannot open its URL on the new box', async () => {
    fetching.mockImplementation(() => {
      setCurrentServer({ id: 'box00000002', host: 'other.example' });
      return Promise.resolve(Response.json(started));
    });
    await expect(beginOpenRouterLogin()).rejects.toThrow('selected box changed');
  });

  test('a stale polling result cannot finish sign-in after an account switch', async () => {
    const login = await beginOpenRouterLogin();
    fetching.mockImplementation(() => {
      clearAccount();
      return Promise.resolve(Response.json({ status: 'done', connection: 'connection' }));
    });
    await expect(pollOpenRouterLogin(login)).rejects.toThrow('account changed');
  });

  test.each(['begin', 'poll', 'cancel'])('a delayed 401 cannot refresh or forward a new account token for %s', async (action) => {
    const login = await beginOpenRouterLogin();
    fetching.mockReset();
    fetching.mockImplementation(() => {
      installTestAccount({ org_id: 'org_other' });
      return Promise.resolve(Response.json({ error: 'expired bearer' }, { status: 401 }));
    });
    const operation = action === 'begin' ? beginOpenRouterLogin() : action === 'poll' ? pollOpenRouterLogin(login) : cancelOpenRouterLogin(login);
    await expect(operation).rejects.toThrow('account changed');
    expect(fetching).toHaveBeenCalledTimes(1);
  });

  test('older daemons keep manual entry, while unknown versions follow the existing gate rule', () => {
    expect(olderThan('0.1.0-beta.260', OPENROUTER_LOGIN_SINCE)).toBe(true);
    expect(olderThan(OPENROUTER_LOGIN_SINCE, OPENROUTER_LOGIN_SINCE)).toBe(false);
    expect(olderThan(null, OPENROUTER_LOGIN_SINCE)).toBe(false);
  });
});
