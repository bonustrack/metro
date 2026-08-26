import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleCliPairRequest } from '../src/daemon/cli-pair-api.js';
import { handleCollectionApiRequest } from '../src/daemon/collection-api.js';
import { signCliToken, signSession, verifyCliToken } from '../src/daemon/session.js';
import type { ConnectorApiDeps } from '../src/daemon/connector-api.js';
import type { ConnectorCollectionRow } from '../src/db/connector-collections.js';

const SECRET = 'a-test-session-secret';
const EMAIL = 'less@bonustrack.co';
const LIST: ConnectorCollectionRow = {
  id: 'list0000001',
  name: 'work',
  connectorIds: ['conn0000001'],
};

const CONNECTOR = {
  id: 'conn0000001',
  name: 'linear',
  url: 'https://mcp.linear.app/mcp',
  transport: 'http' as const,
  auth: 'header' as const,
  header: 'Authorization',
  secret: 'Bearer lin_oauth_7f',
  bearer: null,
  expiresAt: null,
  signIn: null,
  verified: {
    at: 'x',
    server: 's',
    version: '1',
    protocol: 'p',
    icon: '',
    tools: 1,
    catalog: [],
  },
};

const deps = {
  getCollection: async (email: string, id: string) => {
    if (email !== EMAIL || id !== LIST.id) throw new Error('no such collection');
    return Promise.resolve(LIST);
  },
  connectorNamesByIds: async (ids: string[]) =>
    Promise.resolve(
      ids.includes(CONNECTOR.id)
        ? [{ id: CONNECTOR.id, name: CONNECTOR.name }]
        : [],
    ),
} as unknown as ConnectorApiDeps;

let server: Server;
let base = '';
const prev = process.env.METRO_SESSION_SECRET;
const prevPublic = process.env.METRO_PUBLIC_URL;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_PUBLIC_URL = 'https://relay.metro.test';
  server = createServer((req, res) => {
    if (handleCliPairRequest(req, res, deps)) return;
    if (handleCollectionApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  if (prev === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = prev;
  if (prevPublic === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = prevPublic;
});

const session = (): string => signSession({ email: EMAIL, agentIds: [] }, SECRET);
const cliToken = (collectionId = LIST.id): string =>
  signCliToken({ email: EMAIL, collectionId }, SECRET);

const get = (path: string, token?: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const mint = (token?: string): Promise<Response> =>
  fetch(`${base}/api/collections/${LIST.id}/code`, {
    method: 'POST',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const claim = (code: unknown): Promise<Response> =>
  fetch(`${base}/api/cli/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });

async function freshCode(): Promise<string> {
  const body = (await (await mint(session())).json()) as { code: string };
  return body.code;
}

describe('a code authorises one collection, not an account', () => {
  test('minting needs the signed-in owner', async () => {
    expect((await mint()).status).toBe(401);
    expect((await mint('not-a-session')).status).toBe(401);
  });

  test('the mint names the collection it is for', async () => {
    const res = await mint(session());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; collection: string };
    expect(body.code).toMatch(/^mc_[A-Za-z0-9_-]{16}$/);
    expect(body.collection).toBe('work');
  });

  test('claiming takes no session and returns a token bound to that collection', async () => {
    const res = await claim(await freshCode());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; collection: string };
    expect(body.collection).toBe('work');
    expect(verifyCliToken(body.token, SECRET)).toEqual({
      email: EMAIL,
      collectionId: LIST.id,
    });
  });

  test('a code works once and never again', async () => {
    const code = await freshCode();
    expect((await claim(code)).status).toBe(200);
    expect((await claim(code)).status).toBe(400);
  });

  test('a code nobody minted, or a malformed one, is refused', async () => {
    for (const bad of ['mc_aaaaaaaaaaaaaaaa', '', 'nope', 42, null])
      expect((await claim(bad)).status).toBe(400);
  });
});

describe('a CLI token reads its collection and nothing else', () => {
  test('it hands back relay urls carrying the caller token, never the vendor credential', async () => {
    const token = cliToken();
    const res = await get('/api/cli/mcp', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: string; collection: string };
    expect(body.collection).toBe('work');
    expect(JSON.parse(body.json)).toEqual({
      mcpServers: {
        'metro.box linear': {
          type: 'http',
          url: `https://relay.metro.test/relay/${CONNECTOR.id}`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
    expect(body.json).not.toContain('lin_oauth');
    expect(body.json).not.toContain('mcp.linear.app');
  });

  test('it identifies itself by account and collection', async () => {
    const body = (await (await get('/api/cli/session', cliToken())).json()) as {
      email: string;
      collection: string;
    };
    expect(body).toEqual({ email: EMAIL, collection: 'work' });
  });

  test('a SESSION token is not a CLI token — the types do not cross', async () => {
    expect((await get('/api/cli/mcp', session())).status).toBe(401);
    expect((await get('/api/cli/session', session())).status).toBe(401);
  });

  test('a CLI token cannot reach the collection admin routes', async () => {
    expect((await get(`/api/collections/${LIST.id}`, cliToken())).status).toBe(401);
    expect((await get('/api/collections', cliToken())).status).toBe(401);
  });

  test('a CLI token signed by another secret is refused', async () => {
    const other = signCliToken({ email: EMAIL, collectionId: LIST.id }, 'other');
    expect((await get('/api/cli/mcp', other)).status).toBe(401);
  });

  test('no token at all is 401, and the wrong method is 405', async () => {
    expect((await get('/api/cli/mcp')).status).toBe(401);
    expect(
      (await fetch(`${base}/api/cli/mcp`, { method: 'POST' })).status,
    ).toBe(405);
    expect((await get('/api/cli/nope')).status).toBe(404);
  });
});
