import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyConnectors, type CopyTarget } from '../src/api/connector-copy.ts';
import { refreshAccount } from '../src/api/auth.ts';
import { activeAccount, clearAccount, storeAccount } from '../src/auth/account.ts';
import { setCurrentServer } from '../src/auth/daemon.ts';
import { installTestAccount, testToken } from './account-fixture.ts';

const SOURCE = 'org_01SOURCE000000';
const TARGET = 'org_01TARGET000000';
const target: CopyTarget = { organization: TARGET, organizationName: 'Target', id: 'target00001', host: 'target.example', name: 'Target agent' };
const realFetch = globalThis.fetch;
interface Seen { url: string; init: RequestInit; body: Record<string, unknown> }
let calls: Seen[] = [];
let destinationRole = 'admin';
let failedPath = '';
let failureStatus = 403;

beforeEach(() => {
  installTestAccount({ org_id: SOURCE });
  setCurrentServer({ id: 'source00001', host: 'source.example' });
  calls = [];
  destinationRole = 'admin';
  failedPath = '';
  failureStatus = 403;
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url, init, body });
    if (url.endsWith(failedPath) && failedPath !== '') return Promise.resolve(Response.json({ error: 'do-not-reflect-fixture-secret' }, { status: failureStatus }));
    if (url.endsWith('/organizations')) return Promise.resolve(Response.json({ organizations: [
      { id: SOURCE, name: 'Source', role: 'admin', agents: [{ id: target.id, host: target.host, name: target.name }] },
      { id: TARGET, name: 'Target', role: destinationRole, agents: [{ id: target.id, host: target.host, name: target.name }] },
    ] }));
    if (url.endsWith('/switch')) return Promise.resolve(Response.json({ accessToken: testToken({ org_id: body.organization, role: body.organization === SOURCE ? 'admin' : destinationRole }), refreshToken: body.organization === SOURCE ? 'rt_source_restored' : 'rt_destination_rotated', organization: body.organization, user: activeAccount()?.user }));
    if (url.endsWith('/refresh')) return Promise.resolve(Response.json({ accessToken: testToken({ org_id: SOURCE }), refreshToken: 'rt_source_rotated', organization: SOURCE, user: activeAccount()?.user }));
    if (url.endsWith('/prepare')) return Promise.resolve(Response.json({ ticket: 'ticket-fixture', publicKey: 'destination-public-key-fixture' }));
    if (url.endsWith('/export')) return Promise.resolve(Response.json({ key: 'source-public-key-fixture', iv: 'iv-fixture', tag: 'tag-fixture', data: 'encrypted-fixture' }));
    if (url.endsWith('/receive')) return Promise.resolve(Response.json({ results: [{ sourceId: 'conn0000001', id: 'copied00001', status: 'copied' }, { sourceId: 'conn0000002', status: 'skipped' }] }));
    return Promise.resolve(Response.json({}, { status: 404 }));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setCurrentServer(null);
  clearAccount();
});

const authorization = (seen: Seen | undefined): string | null => new Headers(seen?.init.headers).get('authorization');

describe('the single and bulk connector copy client', () => {
  test('authorizes both organizations, prepares the actual destination first, and relays only ciphertext while retaining the source account', async () => {
    const original = activeAccount();
    const result = await copyConnectors(target, ['conn0000001'], true);
    expect(result.map((row) => row.status)).toEqual(['copied', 'skipped']);
    const prepare = calls.find((row) => row.url.endsWith('/prepare'));
    const exported = calls.find((row) => row.url.endsWith('/export'));
    const receive = calls.find((row) => row.url.endsWith('/receive'));
    expect(prepare?.url).toBe('https://target.example/api/connectors/transfer/prepare');
    expect(exported?.url).toBe('https://source.example/api/connectors/transfer/export');
    expect(receive?.url).toBe('https://target.example/api/connectors/transfer/receive');
    expect(authorization(prepare)).toBe(`Bearer ${testToken({ org_id: TARGET })}`);
    expect(authorization(receive)).toBe(authorization(prepare));
    expect(authorization(exported)).toBe(`Bearer ${original?.accessToken ?? ''}`);
    expect(exported?.body).toEqual({ confirmed: true, ids: ['conn0000001'], publicKey: 'destination-public-key-fixture' });
    expect(receive?.body).toEqual({ confirmed: true, ticket: 'ticket-fixture', envelope: { key: 'source-public-key-fixture', iv: 'iv-fixture', tag: 'tag-fixture', data: 'encrypted-fixture' } });
    expect(calls.filter((row) => row.url.includes('/transfer/')).map((row) => row.init.redirect)).toEqual(['manual', 'manual', 'manual']);
    expect(calls.filter((row) => row.url.endsWith('/switch')).map((row) => row.body)).toEqual([
      { organization: TARGET, refreshToken: 'rt_test' }, { organization: SOURCE, refreshToken: 'rt_destination_rotated' },
    ]);
    expect(activeAccount()).toEqual({ ...original, refreshToken: 'rt_source_restored' });
    await refreshAccount();
    expect(calls.at(-1)?.body).toEqual({ refreshToken: 'rt_source_restored' });
    expect(activeAccount()?.organization).toBe(SOURCE);
    expect(activeAccount()?.refreshToken).toBe('rt_source_rotated');
  });

  test('copy all is a live source snapshot, and same-organization copy needs no account switch', async () => {
    await copyConnectors({ ...target, organization: SOURCE }, null, true);
    expect(calls.some((row) => row.url.endsWith('/switch'))).toBe(false);
    expect(calls.find((row) => row.url.endsWith('/export'))?.body.ids).toBeNull();
    expect(authorization(calls.find((row) => row.url.endsWith('/prepare')))).toBe(authorization(calls.find((row) => row.url.endsWith('/export'))));
  });

  test('unconfirmed copies and source members send no requests', async () => {
    await expect(copyConnectors(target, null, false)).rejects.toThrow('Confirm');
    installTestAccount({ org_id: SOURCE, role: 'member' });
    await expect(copyConnectors(target, null, true)).rejects.toThrow('source organization');
    expect(calls).toEqual([]);
  });

  test('a missing destination, member organization, or failed destination authorization prevents source export', async () => {
    await expect(copyConnectors({ ...target, id: 'unknown0001' }, null, true)).rejects.toThrow('no longer');
    destinationRole = 'member';
    await expect(copyConnectors(target, null, true)).rejects.toThrow('no longer');
    destinationRole = 'admin';
    failedPath = '/prepare';
    await expect(copyConnectors(target, null, true)).rejects.toThrow('admin');
    expect(calls.some((row) => row.url.endsWith('/export'))).toBe(false);
  });

  test('rejects the source as destination and hosts containing credentials before any requests', async () => {
    await expect(copyConnectors({ ...target, host: 'source.example' }, null, true)).rejects.toThrow('another agent');
    await expect(copyConnectors({ ...target, host: 'login:secret@target.example' }, null, true)).rejects.toThrow('address');
    expect(calls).toEqual([]);
  });

  test('failed exports never reach receive, and response bodies are not reflected into errors', async () => {
    failedPath = '/export';
    await expect(copyConnectors(target, null, true)).rejects.toThrow('admin');
    expect(calls.some((row) => row.url.endsWith('/receive'))).toBe(false);
    failedPath = '/receive';
    failureStatus = 500;
    let message = '';
    try {
      await copyConnectors(target, null, true);
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).toContain('Retry safely');
    expect(message).not.toContain('do-not-reflect-fixture-secret');
  });

  test('a failed source-session restoration signs out and stops before exporting any credentials', async () => {
    const serve = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (url.endsWith('/switch') && body.organization === SOURCE) return Promise.resolve(Response.json({}, { status: 503 }));
      return serve(url, init);
    }) as unknown as typeof fetch;
    await expect(copyConnectors(target, null, true)).rejects.toThrow('Sign in again');
    expect(activeAccount()).toBeNull();
    expect(calls.some((row) => row.url.includes('/transfer/'))).toBe(false);
  });

  test('a revoked destination admin token is rejected without changing source identity or losing rotated refresh state', async () => {
    const source = activeAccount();
    storeAccount({ ...installTestAccount({ org_id: SOURCE }), role: 'admin' });
    globalThis.fetch = ((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/organizations')) return Promise.resolve(Response.json({ organizations: [{ id: TARGET, role: 'admin', agents: [{ id: target.id, host: target.host }] }] }));
      const body = JSON.parse(String(init.body)) as { organization: string };
      return Promise.resolve(Response.json({ accessToken: testToken({ org_id: body.organization, role: body.organization === SOURCE ? 'admin' : 'member' }), refreshToken: body.organization === SOURCE ? 'rt_source_restored' : 'rt_member_rotated', organization: body.organization, user: source?.user }));
    }) as unknown as typeof fetch;
    await expect(copyConnectors(target, null, true)).rejects.toThrow('admin of the destination');
    expect(activeAccount()).toEqual({ ...source, refreshToken: 'rt_source_restored' });
  });
});
