import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleVaultApiRequest, type VaultApiDeps } from '../src/daemon/vault-api.js';
import { signAgentToken, signSession } from '../src/daemon/session.js';
import { VaultError, type VaultBundle } from '../src/db/vault.js';

const SECRET = 'a-test-session-secret';
const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
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

const session = (subject: string): string => signSession({ subject, agentIds: [] }, SECRET);
const call = (method: string, path: string, token: string | null, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ENVELOPE = { v: 1, agentId: AGENT, nonce: 'n', ciphertext: 'c', key: { recipient: OWNER } };

describe('the vault routes', () => {
  test('a bundle is put, listed without its envelope, fetched with it, and deleted, by its owner only', async () => {
    const put = await call('PUT', `/api/vault/${AGENT}`, session(OWNER), { name: 'Tony', stations: ['xmtp'], envelope: ENVELOPE });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ id: AGENT, name: 'Tony', stations: ['xmtp'], syncedAt: '2026-09-04T12:00:00.000Z' });
    const list = (await (await call('GET', '/api/vault', session(OWNER))).json()) as { entries: unknown[] };
    expect(list.entries).toEqual([{ id: AGENT, name: 'Tony', stations: ['xmtp'], syncedAt: '2026-09-04T12:00:00.000Z' }]);
    expect(JSON.stringify(list)).not.toContain('ciphertext');
    const got = (await (await call('GET', `/api/vault/${AGENT}`, session(OWNER))).json()) as { envelope: unknown };
    expect(got.envelope).toEqual(ENVELOPE);
    expect((await call('GET', `/api/vault/${AGENT}`, session(OTHER))).status).toBe(404);
    expect((await call('PUT', `/api/vault/${AGENT}`, session(OTHER), { name: 'Tony', stations: [], envelope: ENVELOPE })).status).toBe(404);
    expect(((await (await call('GET', '/api/vault', session(OTHER))).json()) as { entries: unknown[] }).entries).toEqual([]);
    expect((await call('DELETE', `/api/vault/${AGENT}`, session(OTHER))).status).toBe(404);
    expect(await (await call('DELETE', `/api/vault/${AGENT}`, session(OWNER))).json()).toEqual({ id: AGENT, name: 'Tony' });
    expect((await call('GET', `/api/vault/${AGENT}`, session(OWNER))).status).toBe(404);
  });

  test('no session, an agent token, a bad id, a wrong method and an oversized body are refused', async () => {
    expect((await call('GET', '/api/vault', null)).status).toBe(401);
    const agentToken = signAgentToken({ subject: OWNER, agentId: AGENT }, SECRET);
    expect((await call('GET', '/api/vault', agentToken)).status).toBe(401);
    expect((await call('GET', '/api/vault/not-an-id', session(OWNER))).status).toBe(404);
    expect((await call('GET', `/api/vault/${AGENT}/more`, session(OWNER))).status).toBe(404);
    expect((await call('POST', '/api/vault', session(OWNER), {})).status).toBe(405);
    expect((await call('POST', `/api/vault/${AGENT}`, session(OWNER), {})).status).toBe(405);
    expect((await call('OPTIONS', '/api/vault', null)).status).toBe(204);
    const huge = await call('PUT', `/api/vault/${AGENT}`, session(OWNER), { name: 'Tony', stations: [], envelope: { ...ENVELOPE, ciphertext: 'x'.repeat(2 * 1024 * 1024 + 70 * 1024) } });
    expect(huge.status).toBe(413);
  });
});
