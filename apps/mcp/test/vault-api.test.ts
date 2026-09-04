import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { handleVaultApiRequest, vaultChallenge, type VaultApiDeps } from '../src/daemon/vault-api.js';
import { signSession } from '../src/daemon/session.js';
import { VaultError } from '../src/db/vault.js';
import type { VaultBundle } from '../src/daemon/vault-types.js';

const SECRET = 'a-test-session-secret';
const OWNER_ACCOUNT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER_ACCOUNT = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const OWNER = OWNER_ACCOUNT.address.toLowerCase();
const OTHER = OTHER_ACCOUNT.address.toLowerCase();
const AGENT = 'bMcXH2uERTe';

let rows: (VaultBundle & { owner: string })[] = [];
const missing = (): VaultError => new VaultError('no such bundle', 404);
const deps: VaultApiDeps = {
  list: (subject) => Promise.resolve(rows.filter((r) => r.owner === subject).map(({ owner: _o, envelope: _e, ...entry }) => entry)),
  put: (subject, id, body) => {
    const input = body as { name: string; stations: string[]; envelope: Record<string, unknown> };
    const held = rows.find((r) => r.id === id);
    if (held !== undefined && held.owner !== subject) return Promise.reject(missing());
    const row = { id, owner: subject, name: input.name, stations: input.stations, envelope: input.envelope, syncedAt: '2026-09-04T12:00:00.000Z' };
    rows = [...rows.filter((r) => r.id !== id), row];
    const { owner: _o, envelope: _e, ...entry } = row;
    return Promise.resolve(entry);
  },
  get: (subject, id) => {
    const row = rows.find((r) => r.id === id && r.owner === subject);
    if (row === undefined) return Promise.reject(missing());
    const { owner: _o, ...bundle } = row;
    return Promise.resolve(bundle);
  },
  remove: (subject, id) => {
    const row = rows.find((r) => r.id === id && r.owner === subject);
    if (row === undefined) return Promise.reject(missing());
    rows = rows.filter((r) => r !== row);
    return Promise.resolve({ id: row.id, name: row.name });
  },
};

let server: Server;
let base = '';
const saved = process.env.METRO_SESSION_SECRET;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  server = createServer((req, res) => {
    if (handleVaultApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  process.env.METRO_SESSION_SECRET = saved;
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

beforeEach(() => {
  rows = [];
});

type Who = typeof OWNER_ACCOUNT | string | null;
async function authHeader(who: Who, method: string, path: string, at = Date.now()): Promise<Record<string, string>> {
  if (who === null) return {};
  if (typeof who === 'string') return { authorization: who };
  const signature = await who.signMessage({ message: vaultChallenge(method, path, at) });
  return { authorization: `Vault ${who.address} ${String(at)} ${signature}` };
}
const call = async (method: string, path: string, who: Who, body?: unknown, at?: number): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(await authHeader(who, method, path, at)),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const session = (subject: string): string => `Bearer ${signSession({ subject, agentIds: [] }, SECRET)}`;
const ENVELOPE = { v: 1, agentId: AGENT, nonce: 'n', ciphertext: 'c', key: { recipient: OWNER } };

describe('the vault routes', () => {
  test('a bundle is put, listed without its envelope, fetched with it, and deleted, by the identity that signs for it only', async () => {
    const put = await call('PUT', `/api/vault/${AGENT}`, OWNER_ACCOUNT, { name: 'Tony', stations: ['xmtp'], envelope: ENVELOPE });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ id: AGENT, name: 'Tony', stations: ['xmtp'], syncedAt: '2026-09-04T12:00:00.000Z' });
    const list = (await (await call('GET', '/api/vault', OWNER_ACCOUNT)).json()) as { entries: unknown[] };
    expect(list.entries).toEqual([{ id: AGENT, name: 'Tony', stations: ['xmtp'], syncedAt: '2026-09-04T12:00:00.000Z' }]);
    expect(JSON.stringify(list)).not.toContain('ciphertext');
    const got = (await (await call('GET', `/api/vault/${AGENT}`, OWNER_ACCOUNT)).json()) as { envelope: unknown };
    expect(got.envelope).toEqual(ENVELOPE);
    expect((await call('GET', `/api/vault/${AGENT}`, OTHER_ACCOUNT)).status).toBe(404);
    expect((await call('PUT', `/api/vault/${AGENT}`, OTHER_ACCOUNT, { name: 'Tony', stations: [], envelope: ENVELOPE })).status).toBe(404);
    expect(((await (await call('GET', '/api/vault', OTHER_ACCOUNT)).json()) as { entries: unknown[] }).entries).toEqual([]);
    expect((await call('DELETE', `/api/vault/${AGENT}`, OTHER_ACCOUNT)).status).toBe(404);
    expect(await (await call('DELETE', `/api/vault/${AGENT}`, OWNER_ACCOUNT)).json()).toEqual({ id: AGENT, name: 'Tony' });
    expect((await call('GET', `/api/vault/${AGENT}`, OWNER_ACCOUNT)).status).toBe(404);
  });

  test('no signature, a session JWT, a stale or forged signature, a bad id, a wrong method and an oversized body are refused', async () => {
    expect((await call('GET', '/api/vault', null)).status).toBe(401);
    expect((await call('GET', '/api/vault', 'Bearer junk')).status).toBe(401);
    expect((await call('GET', '/api/vault', session(OWNER))).status).toBe(401);
    expect((await call('GET', '/api/vault', OWNER_ACCOUNT, undefined, Date.now() - 10 * 60_000)).status).toBe(401);
    const forged = await authHeader(OWNER_ACCOUNT, 'GET', '/api/vault');
    expect((await call('GET', `/api/vault/${AGENT}`, forged.authorization ?? null)).status).toBe(401);
    expect((await call('GET', '/api/vault/not-an-id', OWNER_ACCOUNT)).status).toBe(404);
    expect((await call('GET', `/api/vault/${AGENT}/more`, OWNER_ACCOUNT)).status).toBe(404);
    expect((await call('POST', '/api/vault', OWNER_ACCOUNT, {})).status).toBe(405);
    expect((await call('POST', `/api/vault/${AGENT}`, OWNER_ACCOUNT, {})).status).toBe(405);
    expect((await call('OPTIONS', '/api/vault', null)).status).toBe(204);
    const huge = await call('PUT', `/api/vault/${AGENT}`, OWNER_ACCOUNT, { name: 'Tony', stations: [], envelope: { ...ENVELOPE, ciphertext: 'x'.repeat(2 * 1024 * 1024 + 70 * 1024) } });
    expect(huge.status).toBe(413);
  });
});
