import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleServersApiRequest, type ServersApiDeps } from '../src/servers.js';
import { parseServerHost, parseServerName, type ServerEntry } from '../src/server-types.js';
import { ApiError } from '@metro-labs/http/api-error';
import { parseAvatar } from '../src/avatar.js';
import { pngDataUrl } from './png-fixture.ts';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';

let rows: (ServerEntry & { owner: string })[] = [];
let counter = 0;
const nextId = (): string => `srv${String(counter++).padStart(8, '0')}`;
const nameIn = (body: unknown): string | null => {
  const raw = (body as { name?: unknown }).name;
  return typeof raw === 'string' && raw !== '' ? raw : null;
};
const deps: ServersApiDeps = {
  list: (owner) => Promise.resolve(rows.filter((r) => r.owner === owner).map(({ owner: _o, ...e }) => e)),
  add: (owner, body) => {
    const host = String((body as { host?: unknown }).host ?? '').toLowerCase();
    const held = rows.find((r) => r.owner === owner && r.host === host);
    if (held !== undefined) {
      const { owner: _o, ...entry } = held;
      return Promise.resolve(entry);
    }
    const row = { owner, id: nextId(), host, name: nameIn(body), addedAt: '2026-09-05T20:00:00.000Z', instanceId: null, launchedAt: null, avatar: null };
    rows = [...rows, row];
    const { owner: _o, ...entry } = row;
    return Promise.resolve(entry);
  },
  rename: (owner, id, body) => {
    const held = rows.find((r) => r.owner === owner && r.id === id);
    if (held === undefined) return Promise.reject(new ApiError('no such server', 404));
    held.name = nameIn(body);
    const { owner: _o, ...entry } = held;
    return Promise.resolve(entry);
  },
  remove: (owner, id) => {
    const held = rows.find((r) => r.owner === owner && r.id === id);
    if (held === undefined) return Promise.reject(new ApiError('no such server', 404));
    rows = rows.filter((r) => r !== held);
    return Promise.resolve({ id, host: held.host });
  },
  avatar: (owner, id, body) => {
    const held = rows.find((r) => r.owner === owner && r.id === id);
    if (held === undefined) return Promise.reject(new ApiError('no such server', 404));
    held.avatar = parseAvatar((body as { avatar?: unknown }).avatar);
    const { owner: _o, ...entry } = held;
    return Promise.resolve(entry);
  },
  claim: (from, to) => {
    let moved = 0;
    for (const r of rows) if (r.owner === from) { r.owner = to; moved += 1; }
    return Promise.resolve(moved);
  },
};
let issuer: FakeIssuer;

let server: Server;
let base = '';

beforeAll(async () => {
  issuer = await fakeIssuer();
  deps.keys = new SigningKeys(issuer.url);
  server = createServer((req, res) => {
    if (handleServersApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.close();
  await issuer.close();
});

beforeEach(() => {
  rows = [];
});

const call = async (method: string, path: string, who: typeof TEST_OWNER | null, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(who === null ? {} : { authorization: await auth(method, path, who) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the server list on metro.box', () => {
  test('a signed identity adds, lists, renames and removes its servers by id; another identity sees none of them', async () => {
    const owner = TEST_OWNER.address.toLowerCase();
    const added = (await (await call('POST', '/api/servers', TEST_OWNER, { host: 'Suzy.tail1234.ts.net', name: 'Suzy' })).json()) as ServerEntry;
    expect(added).toMatchObject({ id: 'srv00000000', host: 'suzy.tail1234.ts.net', name: 'Suzy' });
    const again = (await (await call('POST', '/api/servers', TEST_OWNER, { host: 'suzy.tail1234.ts.net' })).json()) as ServerEntry;
    expect(again.id).toBe(added.id);
    expect((await call('POST', '/api/servers', TEST_OWNER, { host: '127.0.0.1:8420' })).status).toBe(200);
    const list = (await (await call('GET', '/api/servers', TEST_OWNER)).json()) as { servers: ServerEntry[] };
    expect(list.servers.map((s) => [s.host, s.name])).toEqual([['suzy.tail1234.ts.net', 'Suzy'], ['127.0.0.1:8420', null]]);
    expect(rows.every((r) => r.owner === owner)).toBe(true);
    const renamed = (await (await call('PUT', `/api/servers/${added.id}`, TEST_OWNER, { name: 'Suzy on EC2' })).json()) as ServerEntry;
    expect(renamed.name).toBe('Suzy on EC2');
    const other = (await (await call('GET', '/api/servers', TEST_STRANGER)).json()) as { servers: ServerEntry[] };
    expect(other.servers).toEqual([]);
    expect((await call('DELETE', `/api/servers/${added.id}`, TEST_STRANGER)).status).toBe(404);
    expect((await call('DELETE', `/api/servers/${added.id}`, TEST_OWNER)).status).toBe(200);
    expect(rows.map((r) => r.host)).toEqual(['127.0.0.1:8420']);
  });

  test('no signature is 401, a bad id or path is 404, a wrong method 405, and preflight passes', async () => {
    expect((await call('GET', '/api/servers', null)).status).toBe(401);
    expect((await call('POST', '/api/servers', null, { host: 'x.ts.net' })).status).toBe(401);
    expect((await call('PUT', '/api/servers/not-an-id', TEST_OWNER, {})).status).toBe(404);
    expect((await call('PUT', '/api/servers/srv00000000/x', TEST_OWNER, {})).status).toBe(404);
    expect((await call('PATCH', '/api/servers', TEST_OWNER, {})).status).toBe(405);
    expect((await call('GET', '/api/servers/srv00000000', TEST_OWNER)).status).toBe(405);
    expect((await fetch(`${base}/api/servers`, { method: 'OPTIONS' })).status).toBe(204);
    const preflight = await fetch(`${base}/api/servers/claim`, { method: 'OPTIONS', headers: { origin: 'https://metro.box', 'access-control-request-headers': 'authorization,x-metro-wallet' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Metro-Wallet');
  });

  test('an avatar is set and removed on its own route; only a PNG the owner sends is stored', async () => {
    const added = (await (await call('POST', '/api/servers', TEST_OWNER, { host: 'suzy.tail1234.ts.net' })).json()) as ServerEntry;
    const png = pngDataUrl(128, 128);
    const set = await call('PUT', `/api/servers/${added.id}/avatar`, TEST_OWNER, { avatar: png });
    expect(set.status).toBe(200);
    expect(((await set.json()) as ServerEntry).avatar).toBe(png);
    const list = (await (await call('GET', '/api/servers', TEST_OWNER)).json()) as { servers: ServerEntry[] };
    expect(list.servers[0]?.avatar).toBe(png);
    expect((await call('PUT', `/api/servers/${added.id}/avatar`, TEST_STRANGER, { avatar: png })).status).toBe(404);
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;
    expect((await call('PUT', `/api/servers/${added.id}/avatar`, TEST_OWNER, { avatar: svg })).status).toBe(400);
    expect((await call('GET', `/api/servers/${added.id}/avatar`, TEST_OWNER)).status).toBe(405);
    expect((await call('PUT', `/api/servers/${added.id}/other`, TEST_OWNER, { avatar: png })).status).toBe(404);
    const cleared = await call('PUT', `/api/servers/${added.id}/avatar`, TEST_OWNER, { avatar: null });
    expect(((await cleared.json()) as ServerEntry).avatar).toBeNull();
  });

  test('a WorkOS token lists the organization\'s servers, and a claim moves the wallet\'s rows to the organization', async () => {
    const owner = TEST_OWNER.address.toLowerCase();
    await call('POST', '/api/servers', TEST_OWNER, { host: 'lisa.tail1234.ts.net', name: 'Lisa' });
    await call('POST', '/api/servers', TEST_OWNER, { host: 'tony.tail1234.ts.net', name: 'Tony' });
    const bearer = issuer.mint(sessionClaims({ org_id: 'org_01STAGELABS000', role: 'admin' }));
    const before = (await (await fetch(`${base}/api/servers`, { headers: { authorization: `Bearer ${bearer}` } })).json()) as { servers: ServerEntry[] };
    expect(before.servers).toEqual([]);
    const walletHeader = await auth('POST', '/api/servers/claim', TEST_OWNER);
    const noWallet = await fetch(`${base}/api/servers/claim`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
    expect(noWallet.status).toBe(400);
    const claimed = await fetch(`${base}/api/servers/claim`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'x-metro-wallet': walletHeader } });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({ moved: 2 });
    const after = (await (await fetch(`${base}/api/servers`, { headers: { authorization: `Bearer ${bearer}` } })).json()) as { servers: ServerEntry[] };
    expect(after.servers.map((s) => s.name)).toEqual(['Lisa', 'Tony']);
    expect(rows.every((r) => r.owner === 'org_01STAGELABS000')).toBe(true);
    expect(rows.some((r) => r.owner === owner)).toBe(false);
    const orgless = issuer.mint(sessionClaims({ org_id: undefined }));
    expect((await fetch(`${base}/api/servers`, { headers: { authorization: `Bearer ${orgless}` } })).status).toBe(401);
  });

  test('hosts are lowercased and validated, names trimmed, stripped and capped', () => {
    expect(parseServerHost(' Suzy.Tail1234.TS.net ')).toBe('suzy.tail1234.ts.net');
    expect(parseServerHost('127.0.0.1:8420')).toBe('127.0.0.1:8420');
    expect(parseServerHost('https://x.ts.net')).toBeNull();
    expect(parseServerHost('x.ts.net/path')).toBeNull();
    expect(parseServerHost('-bad')).toBeNull();
    expect(parseServerName(' Suzy\u0000 on EC2 ')).toBe('Suzy on EC2');
    expect(parseServerName('x'.repeat(60))).toHaveLength(40);
    expect(parseServerName('   ')).toBeNull();
    expect(parseServerName(7)).toBeNull();
  });
});
