import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleCollectionApiRequest } from '../src/daemon/collection-api.js';
import { signCliToken, signSession } from '../src/daemon/session.js';
import { ApiError } from '../src/daemon/api-error.js';
import type { ConnectorApiDeps } from '../src/daemon/connector-api.js';
import type { ConnectorCollectionRow } from '../src/db/connector-collections.js';

const SECRET = 'a-test-session-secret';
const ADA = 'ada@lovelace.dev';
const BOB = 'bob@example.com';
const CONNECTOR = 'cnn00000001';

interface Row extends ConnectorCollectionRow {
  email: string;
}

let rows: Row[] = [];
const seed = (): Row[] => [
  { id: 'lst00000001', email: ADA, name: 'work', connectorIds: [CONNECTOR] },
  { id: 'lst00000002', email: BOB, name: 'theirs', connectorIds: [] },
];

const CLASHING_CONNECTOR = 'cnn00000009';

const missing = (): ApiError => new ApiError('no such collection', 404);

function owned(email: string, id: string): Row {
  const row = rows.find((r) => r.id === id && r.email === email);
  if (row === undefined) throw missing();
  return row;
}

const strip = ({ email, ...rest }: Row): ConnectorCollectionRow => rest;

const deps = {
  listCollections: async (email: string, _project: string) =>
    Promise.resolve(rows.filter((r) => r.email === email).map(strip)),
  getCollection: async (email: string, id: string) =>
    Promise.resolve(strip(owned(email, id))),
  createCollection: async (email: string, _project: string, name: string) => {
    if (rows.some((r) => r.email === email && r.name === name))
      throw new ApiError(`you already have a collection named '${name}'`, 409);
    const row: Row = {
      id: `lst0000000${String(rows.length + 1)}`,
      email,
      name,
      connectorIds: [],
    };
    rows.push(row);
    return Promise.resolve(strip(row));
  },
  renameCollection: async (email: string, id: string, name: string) => {
    const row = owned(email, id);
    row.name = name;
    return Promise.resolve(strip(row));
  },
  deleteCollection: async (email: string, id: string) => {
    const row = owned(email, id);
    rows = rows.filter((r) => r.id !== id);
    return Promise.resolve({ id: row.id, name: row.name });
  },
  addToCollection: async (email: string, id: string, connectorId: string) => {
    if (connectorId === CLASHING_CONNECTOR)
      throw new ApiError(
        "the collection 'work' already has a connector named 'linear'",
        409,
      );
    const row = owned(email, id);
    if (!row.connectorIds.includes(connectorId)) row.connectorIds.push(connectorId);
    return Promise.resolve(strip(row));
  },
  removeFromCollection: async (email: string, id: string, connectorId: string) => {
    const row = owned(email, id);
    row.connectorIds = row.connectorIds.filter((c) => c !== connectorId);
    return Promise.resolve(strip(row));
  },
} as unknown as ConnectorApiDeps;

let server: Server;
let base = '';
const prev = process.env.METRO_SESSION_SECRET;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  server = createServer((req, res) => {
    if (handleCollectionApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(() => {
  rows = seed();
});

afterAll(() => {
  server.close();
  if (prev === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = prev;
});

const session = (email: string): string =>
  signSession({ email, agentIds: [] }, SECRET);

const PROJECT = 'prj00000001';

const withProject = (path: string): string =>
  path.includes('?')
    ? `${path}&project=${PROJECT}`
    : `${path}?project=${PROJECT}`;

const call = (
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> =>
  fetch(`${base}${withProject(path)}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('collections belong to the signed-in person', () => {
  test('the index lists only your own', async () => {
    const res = await call('GET', '/api/collections', session(ADA));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { collections: ConnectorCollectionRow[] };
    expect(body.collections.map((l) => l.name)).toEqual(['work']);
  });

  test('every route needs a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/collections'],
      ['POST', '/api/collections'],
      ['GET', '/api/collections/lst00000001'],
      ['DELETE', '/api/collections/lst00000001'],
      ['POST', '/api/collections/lst00000001/rename'],
      ['POST', '/api/collections/lst00000001/code'],
    ])
      expect((await call(method ?? '', path ?? '')).status).toBe(401);
  });

  test('a CLI token is not a session here', async () => {
    const cli = signCliToken({ email: ADA, collectionId: 'lst00000001' }, SECRET);
    expect((await call('GET', '/api/collections', cli)).status).toBe(401);
  });

  test("somebody else's collection and one that never existed are the same 404", async () => {
    for (const id of ['lst00000002', 'lst09999999'])
      expect((await call('GET', `/api/collections/${id}`, session(ADA))).status).toBe(404);
  });
});

describe('creating, renaming and deleting a collection', () => {
  test('a create returns the empty collection', async () => {
    const res = await call('POST', '/api/collections', session(ADA), { name: 'home' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: 'home', connectorIds: [] });
  });

  test('a duplicate name for the same person is 409', async () => {
    expect(
      (await call('POST', '/api/collections', session(ADA), { name: 'work' })).status,
    ).toBe(409);
  });

  test('a missing or non-string name is 400', async () => {
    for (const body of [{}, { name: 7 }, { name: null }])
      expect((await call('POST', '/api/collections', session(ADA), body)).status).toBe(400);
  });

  test('rename answers with the new name', async () => {
    const res = await call('POST', '/api/collections/lst00000001/rename', session(ADA), {
      name: 'day job',
    });
    expect(await res.json()).toMatchObject({ name: 'day job' });
  });

  test('delete answers with what it removed', async () => {
    const res = await call('DELETE', '/api/collections/lst00000001', session(ADA));
    expect(await res.json()).toEqual({ id: 'lst00000001', name: 'work' });
    expect((await (await call('GET', '/api/collections', session(ADA))).json()) as unknown).toEqual({
      collections: [],
    });
  });
});

describe('membership', () => {
  test('a connector can be added and removed', async () => {
    const added = await call('POST', '/api/collections/lst00000001/items', session(ADA), {
      connectorId: 'cnn00000002',
    });
    expect(await added.json()).toMatchObject({
      connectorIds: [CONNECTOR, 'cnn00000002'],
    });
    const removed = await call(
      'DELETE',
      `/api/collections/lst00000001/items/${CONNECTOR}`,
      session(ADA),
    );
    expect(await removed.json()).toMatchObject({ connectorIds: ['cnn00000002'] });
  });

  test('a connector whose name a member already has is 409', async () => {
    const res = await call('POST', '/api/collections/lst00000001/items', session(ADA), {
      connectorId: CLASHING_CONNECTOR,
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: "the collection 'work' already has a connector named 'linear'",
    });
  });

  test('an id-shaped connectorId is required', async () => {
    for (const body of [{}, { connectorId: 'nope' }, { connectorId: 9 }])
      expect(
        (await call('POST', '/api/collections/lst00000001/items', session(ADA), body))
          .status,
      ).toBe(400);
  });
});

describe('the shape of the route itself', () => {
  test('a wrong method is 405, decided before the session', async () => {
    expect((await call('PUT', '/api/collections', session(ADA))).status).toBe(405);
    expect((await call('GET', '/api/collections/lst00000001/rename', session(ADA))).status).toBe(405);
    expect((await call('PUT', '/api/collections')).status).toBe(405);
  });

  test('an unknown sub-route is 404', async () => {
    expect((await call('POST', '/api/collections/lst00000001/nope', session(ADA))).status).toBe(404);
    expect((await call('GET', '/api/collections/not-an-id', session(ADA))).status).toBe(404);
  });

  test('minting a code names the collection it authorizes', async () => {
    const res = await call('POST', '/api/collections/lst00000001/code', session(ADA));
    const body = (await res.json()) as { code: string; collection: string };
    expect(body.code).toMatch(/^mc_[A-Za-z0-9_-]{16}$/);
    expect(body.collection).toBe('work');
  });
});
