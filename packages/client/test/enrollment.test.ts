import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { setCurrentServer } from '../src/auth/daemon.js';
import { createEnrollment, type Enrollment } from '../src/api/enrollment.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { installTestAccount, TEST_ORGANIZATION } from './account-fixture.js';

const realFetch = globalThis.fetch;
const server = { id: 'central0001', host: 'agent.example' };
const CENTRAL = `https://api.metro.box/api/servers/${server.id}/enrollment`;
const LOCAL = 'https://agent.example/api/enrollment';
const MODE = 'https://agent.example/api/mode';
const MODE_BODY = { mode: 'local', owner: TEST_ORGANIZATION, version: '0.1.0-beta.288' };
const TICKET = 't'.repeat(43);
const RESULT = { server: server.id, organization: TEST_ORGANIZATION, keyId: 'k'.repeat(43) };
let requests: Array<{ url: string; init: RequestInit }>;
let flows: Enrollment[];
let mint: unknown;
let response: unknown;
let mintStatus: number;
let localStatus: number;

function flow(): Enrollment {
  const value = createEnrollment(server);
  flows.push(value);
  return value;
}

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue() });
  installTestAccount();
  setCurrentServer(server);
  requests = [];
  flows = [];
  mint = { ticket: TICKET, expiresAt: Date.now() + 600_000 };
  response = RESULT;
  mintStatus = 200;
  localStatus = 200;
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    if (url === MODE) return Promise.resolve(Response.json(MODE_BODY));
    requests.push({ url, init });
    if (url === CENTRAL) return Promise.resolve(Response.json(mint, { status: mintStatus }));
    if (url === LOCAL) return Promise.resolve(Response.json(response, { status: localStatus }));
    throw new Error('Unexpected request');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const value of flows) value.dispose();
  globalThis.fetch = realFetch;
  clearAccount();
  setCurrentServer(null);
});

describe('explicit organization enrollment', () => {
  test('only confirmation sends the two scoped admin requests, using the central row id', async () => {
    const enrollment = flow();
    expect(requests).toHaveLength(0);
    expect(await enrollment.run()).toEqual({ server: server.id, organization: TEST_ORGANIZATION });
    expect(requests.map((row) => [row.url, row.init.method, row.init.body])).toEqual([
      [CENTRAL, 'POST', undefined], [LOCAL, 'POST', JSON.stringify({ ticket: TICKET })],
    ]);
    expect(requests[0]?.init.headers).toEqual(requests[1]?.init.headers === undefined ? {} : { authorization: new Headers(requests[1].init.headers).get('authorization') });
    for (const { init } of requests) {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    await expect(enrollment.run()).rejects.toThrow('already running or complete');
    expect(requests).toHaveLength(2);
  });

  test('members and signed-out users send no requests', async () => {
    installTestAccount({ role: 'member' });
    await expect(flow().run()).rejects.toThrow('Only an admin');
    clearAccount();
    await expect(flow().run()).rejects.toThrow('changed');
    expect(requests).toHaveLength(0);
  });

  test('setup off stops before contacting the daemon and never changes flags', async () => {
    mintStatus = 503;
    mint = { error: 'Organization connectors are not switched on yet.' };
    await expect(flow().run()).rejects.toThrow('Enrollment did not start');
    expect(requests.map((row) => row.url)).toEqual([CENTRAL]);
  });

  test('old daemons show an Update notice without exposing the response body', async () => {
    localStatus = 404;
    response = { error: `private ${TICKET}` };
    await expect(flow().run()).rejects.toThrow('Update this agent');
  });

  test('rejects malformed and expired tickets before sending them anywhere', async () => {
    for (const value of [null, { ticket: TICKET }, { ticket: 'private', expiresAt: Date.now() + 1000 }, { ticket: TICKET, expiresAt: Date.now() - 1 }]) {
      mint = value;
      await expect(flow().run()).rejects.toThrow('valid enrollment ticket');
    }
    expect(requests.every((row) => row.url === CENTRAL)).toBe(true);
  });

  test('validates the returned central identity and never projects credentials or the key id', async () => {
    for (const value of [{ ...RESULT, server: 'local-agent' }, { ...RESULT, organization: 'org_other' }, { ...RESULT, keyId: 'private' }]) {
      response = value;
      await expect(flow().run()).rejects.toThrow('different or invalid identity');
    }
    response = { ...RESULT, ticket: TICKET, secret: 'private' };
    expect(await flow().run()).toEqual({ server: server.id, organization: TEST_ORGANIZATION });
  });

  test('an account switch during ticket minting discards the ticket and aborts the request', async () => {
    const serve = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const result = serve(url, init);
      if (url === CENTRAL) installTestAccount({ org_id: 'org_other' });
      return result;
    }) as unknown as typeof fetch;
    await expect(flow().run()).rejects.toThrow('changed');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.signal?.aborted).toBe(true);
  });

  test('agent changes, including switching away and back, cannot redeem a captured ticket', async () => {
    const enrollment = flow();
    setCurrentServer({ id: 'other000001', host: 'other.example' });
    setCurrentServer(server);
    await expect(enrollment.run()).rejects.toThrow('changed');
    expect(requests).toHaveLength(0);
  });

  test('a destination change during minting never receives the ticket or bearer', async () => {
    const serve = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const result = serve(url, init);
      if (url === CENTRAL) setCurrentServer({ ...server, host: 'other.example' });
      return result;
    }) as unknown as typeof fetch;
    await expect(flow().run()).rejects.toThrow('changed');
    expect(requests.map((row) => row.url)).toEqual([CENTRAL]);
  });

  test('account switches during the daemon response never report success', async () => {
    const serve = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const result = serve(url, init);
      if (url === LOCAL) { clearAccount(); installTestAccount(); }
      return result;
    }) as unknown as typeof fetch;
    await expect(flow().run()).rejects.toThrow('changed');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.init.signal?.aborted).toBe(true);
  });

  test('retry after an interrupted daemon confirmation reuses the same one-use ticket for recovery', async () => {
    let minted = 0;
    let exchanges = 0;
    let remoteCommitted = false;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      if (url === MODE) return Promise.resolve(Response.json(MODE_BODY));
      requests.push({ url, init });
      if (url === CENTRAL) { minted += 1; return Promise.resolve(Response.json(mint)); }
      expect(url).toBe(LOCAL);
      expect(init.body).toBe(JSON.stringify({ ticket: TICKET }));
      if (!remoteCommitted) {
        remoteCommitted = true;
        exchanges += 1;
        return Promise.reject(new Error(`private ${TICKET}`));
      }
      return Promise.resolve(Response.json(RESULT));
    }) as unknown as typeof fetch;
    const enrollment = flow();
    await expect(enrollment.run()).rejects.toThrow('may have reached the agent');
    expect(await enrollment.run()).toEqual({ server: server.id, organization: TEST_ORGANIZATION });
    expect(minted).toBe(1);
    expect(exchanges).toBe(1);
    expect(requests).toHaveLength(3);
  });

  test('duplicate clicks and a second dialog cannot mint another ticket during an active request', async () => {
    const serve = globalThis.fetch;
    let finish: (() => void) | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url === CENTRAL) await new Promise<void>((resolve) => { finish = resolve; });
      return serve(url, init);
    }) as unknown as typeof fetch;
    const enrollment = flow();
    const first = enrollment.run();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await expect(enrollment.run()).rejects.toThrow('already running');
    await expect(flow().run()).rejects.toThrow('already running');
    finish?.();
    await first;
    expect(requests).toHaveLength(2);
  });

  test('closing the operation aborts in flight work and does not continue on retry', async () => {
    const serve = globalThis.fetch;
    const enrollment = flow();
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const result = serve(url, init);
      if (url === CENTRAL) enrollment.dispose();
      return result;
    }) as unknown as typeof fetch;
    await expect(enrollment.run()).rejects.toThrow('changed');
    await expect(enrollment.run()).rejects.toThrow('changed');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.signal?.aborted).toBe(true);
  });

  test('a consumed ticket after a lost final reply permits an explicit fresh-ticket retry', async () => {
    let minted = 0;
    let completed = 0;
    const used = new Set<string>();
    globalThis.fetch = ((url: string, init: RequestInit) => {
      if (url === MODE) return Promise.resolve(Response.json(MODE_BODY));
      if (url === CENTRAL) {
        minted += 1;
        return Promise.resolve(Response.json({ ticket: String(minted).repeat(43), expiresAt: Date.now() + 600_000 }));
      }
      const body = init.body as string;
      if (used.has(body)) return Promise.resolve(Response.json({ error: 'This enrollment ticket is stale or belongs to another organization. Start again from the agent page.' }, { status: 400 }));
      used.add(body);
      completed += 1;
      if (completed === 1) return Promise.reject(new Error('reply lost after daemon cleared pending key'));
      return Promise.resolve(Response.json(RESULT));
    }) as unknown as typeof fetch;
    const enrollment = flow();
    await expect(enrollment.run()).rejects.toThrow('may have reached the agent');
    await expect(enrollment.run()).rejects.toThrow('Retry to request a new ticket');
    expect(minted).toBe(1);
    expect(completed).toBe(1);
    await enrollment.run();
    expect(minted).toBe(2);
    expect(completed).toBe(2);
  });

  test('published old daemons are rejected before their POST fallback or any mint', async () => {
    const calls: string[] = [];
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push(url);
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url === MODE) return Promise.resolve(Response.json({ ...MODE_BODY, version: '0.1.0-beta.287' }));
      return Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }));
    }) as unknown as typeof fetch;
    await expect(flow().run()).rejects.toThrow('Update this agent');
    expect(calls).toEqual([MODE]);
  });

  test('a daemon owned by another organization is rejected before minting', async () => {
    globalThis.fetch = (() => Promise.resolve(Response.json({ ...MODE_BODY, owner: 'org_other' }))) as unknown as typeof fetch;
    await expect(flow().run()).rejects.toThrow('does not belong');
    expect(requests).toHaveLength(0);
  });

  test('registered default ports normalize to the same captured daemon origin', async () => {
    for (const [host, origin] of [['agent.example:443', 'https://agent.example'], ['localhost:80', 'http://localhost']]) {
      const selected = { ...server, host: host ?? '' };
      setCurrentServer(selected);
      const calls: string[] = [];
      globalThis.fetch = ((url: string) => {
        calls.push(url);
        return Promise.resolve(Response.json(url === CENTRAL ? mint : url.endsWith('/api/mode') ? MODE_BODY : RESULT));
      }) as unknown as typeof fetch;
      const enrollment = createEnrollment(selected);
      flows.push(enrollment);
      await enrollment.run();
      expect(calls).toEqual([`${origin}/api/mode`, CENTRAL, `${origin}/api/enrollment`]);
    }
  });

  test('a failed enrollment says it may have reached the agent, without naming connector sync', async () => {
    localStatus = 503;
    response = { error: 'private upstream error' };
    const message = await flow().run().catch((error: unknown) => error instanceof Error ? error.message : '');
    expect(message).toBe('Enrollment could not be confirmed and may have reached the agent. Try again.');
    expect(message).not.toContain('private');
  });

  test('unknown refusal text is not returned to the UI', async () => {
    localStatus = 409;
    response = { error: `private ${TICKET}` };
    const message = await flow().run().catch((error: unknown) => error instanceof Error ? error.message : '');
    expect(message).toContain('could not be confirmed');
    expect(message).not.toContain(TICKET);
    expect(message).not.toContain('private');
  });
});
