import { afterEach, beforeEach, expect, test } from 'bun:test';
import { connectorCopyNameError, copyOrgConnector } from '../src/api/org-connectors.js';
import { activeAccount, clearAccount } from '../src/auth/account.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { installTestAccount } from './account-fixture.js';

const realFetch = globalThis.fetch;
const DESTINATION = 'org_DESTINATION0000';
const connector = { id: 'copied00001', name: 'Copied connector', auth: 'oauth', signIn: 'disconnected', policy: { read: 'ask', tools: { erase: 'deny' } }, agents: [] };

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue() });
  installTestAccount();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
  configurePlatform({ kv: memoryKeyValue() });
});

test('copy sends only the explicit sharing confirmation, destination and trimmed name with the source bearer', async () => {
  const account = activeAccount();
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Promise.resolve(Response.json({ organization: DESTINATION, connector: { ...connector, secret: 'SERVER_ONLY', clientSecret: 'SERVER_ONLY' } }, { status: 201 }));
  }) as typeof fetch;
  const result = await copyOrgConnector('source00001', { organization: DESTINATION, name: '  Copied connector  ', shareCredentials: true });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe('https://api.metro.box/api/connectors/source00001/copy');
  expect(requests[0]?.init?.method).toBe('POST');
  expect(requests[0]?.init?.redirect).toBe('error');
  expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(`Bearer ${account?.accessToken ?? ''}`);
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ organization: DESTINATION, name: 'Copied connector', shareCredentials: true });
  expect(result).toMatchObject({ organization: DESTINATION, connector });
  expect(result.connector).not.toHaveProperty('secret');
  expect(result.connector).not.toHaveProperty('clientSecret');
  expect(activeAccount()).toEqual(account);
});

test.each([401, 403, 404, 409, 503])('HTTP %i never refreshes or retries a copy', async (status) => {
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    return Promise.resolve(Response.json({ error: 'Copy refused.' }, { status }));
  }) as typeof fetch;
  await expect(copyOrgConnector('source00001', { organization: DESTINATION, name: 'Copy', shareCredentials: true })).rejects.toThrow(status === 401 ? 'not authorized' : 'Copy refused.');
  expect(calls).toEqual(['https://api.metro.box/api/connectors/source00001/copy']);
});

test('a network failure never retries a copy', async () => {
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.reject(new Error('Connection lost.'));
  }) as typeof fetch;
  await expect(copyOrgConnector('source00001', { organization: DESTINATION, name: 'Copy', shareCredentials: true })).rejects.toThrow('Failed to reach Metro.');
  expect(calls).toBe(1);
});

test.each(['', '   ', 'x'.repeat(65), 'bad\u0000name', 'bad\u001fname', 'bad\u007fname'])('an invalid name is rejected before sending: %j', async (name) => {
  let calls = 0;
  globalThis.fetch = (() => { calls += 1; return Promise.resolve(Response.json({})); }) as typeof fetch;
  expect(connectorCopyNameError(name)).not.toBeNull();
  await expect(copyOrgConnector('source00001', { organization: DESTINATION, name, shareCredentials: true })).rejects.toThrow();
  expect(calls).toBe(0);
});

test('name validation matches the saved connector bounds after trimming', () => {
  expect(connectorCopyNameError(` ${'x'.repeat(64)} `)).toBeNull();
  expect(connectorCopyNameError(' Shared account é ')).toBeNull();
});

test('an unexpected destination or malformed copied connector is not accepted as success', async () => {
  globalThis.fetch = (() => Promise.resolve(Response.json({ organization: 'org_WRONG00000000', connector }, { status: 201 }))) as typeof fetch;
  await expect(copyOrgConnector('source00001', { organization: DESTINATION, name: 'Copy', shareCredentials: true })).rejects.toThrow('unexpected response');
  globalThis.fetch = (() => Promise.resolve(Response.json({ organization: DESTINATION, connector: {} }, { status: 201 }))) as typeof fetch;
  await expect(copyOrgConnector('source00001', { organization: DESTINATION, name: 'Copy', shareCredentials: true })).rejects.toThrow('unexpected response');
});
