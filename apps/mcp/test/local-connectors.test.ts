import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSessionApis, type SessionApis } from '../src/daemon/session-apis.js';
import { localSessionApis } from '../src/daemon/local-mode.js';
import { ensureLocalSessionSecret } from '../src/daemon/local-secret.js';
import { signSession } from '../src/daemon/session.js';
import { claimLocalOwner, localCreateAgent, LOCAL_PROJECT_ID } from '../src/db/file-admin.js';
import { setKeyMap } from '../src/db/key-map.js';
import { forgetHostedConnectors, hostedCredentialsFor } from '../src/daemon/hosted-connectors.js';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const STRANGER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const SUMMARIES = [
  { id: 'conn0000001', name: 'linear', url: 'https://mcp.linear.app/mcp', transport: 'http', signIn: 'connected' },
  { id: 'conn0000002', name: 'github', url: 'https://api.githubcopilot.com/mcp', transport: 'http', signIn: null },
];
const saved = {
  dir: process.env.METRO_AGENTS_DIR,
  secret: process.env.METRO_SESSION_SECRET,
  url: process.env.METRO_URL,
  config: process.env.METRO_CONFIG_DIR,
};
let dir = '';
let metro: Server;
let local: Server;
let base = '';
let secret = '';
let tony = { id: '', key: '' };
let orphan = { id: '', key: '' };
const asked: string[] = [];
const loginTokenFor = (agentId: string): string =>
  `h.${Buffer.from(JSON.stringify({ agent: agentId })).toString('base64url')}.s`;

const listen = (server: Server): Promise<string> =>
  new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-local-conn-'));
  process.env.METRO_AGENTS_DIR = dir;
  process.env.METRO_CONFIG_DIR = join(dir, 'config');
  mkdirSync(join(dir, 'config'), { recursive: true });
  delete process.env.METRO_SESSION_SECRET;
  secret = ensureLocalSessionSecret(dir);
  setKeyMap([]);
  forgetHostedConnectors();
  await claimLocalOwner(OWNER, dir);
  tony = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'Tony', dir);
  orphan = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'orphan', dir);
  metro = createServer((req, res) => {
    asked.push(req.headers.authorization ?? '');
    const auth = req.headers.authorization ?? '';
    const accepted = auth === 'Bearer rt-tony' || auth === `Bearer ${loginTokenFor(tony.id)}`;
    if (req.url === '/api/cli/connectors' && accepted) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agent: 'Tony', connectors: SUMMARIES }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
  });
  process.env.METRO_URL = await listen(metro);
  writeFileSync(
    join(dir, 'config', `runtime-${tony.id}.json`),
    JSON.stringify({ token: 'rt-tony', url: process.env.METRO_URL }),
  );
  const apis: SessionApis = localSessionApis({
    syncStations: () => Promise.resolve(),
    closeAgentSession: () => Promise.resolve(true),
    gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }),
    capabilities: () => ({}),
    liveness: () => new Map(),
    prepareAccount: () => Promise.reject(new Error('not used')),
  });
  local = createServer((req, res) => {
    if (handleSessionApis(req, res, apis)) return;
    res.writeHead(404).end();
  });
  base = await listen(local);
});

afterAll(() => {
  local.close();
  metro.close();
  forgetHostedConnectors();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ['METRO_AGENTS_DIR', saved.dir],
    ['METRO_SESSION_SECRET', saved.secret],
    ['METRO_URL', saved.url],
    ['METRO_CONFIG_DIR', saved.config],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const get = (path: string, subject = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${signSession({ subject, agentIds: [] }, secret)}` } });

describe('connectors on a local daemon come from metro.box through the agent\'s own token', () => {
  test('the credentials are a matching metro login first, then the runtime file the import wrote', () => {
    const cfg = join(dir, 'config');
    expect(hostedCredentialsFor(tony.id, cfg)).toEqual([{ token: 'rt-tony', url: process.env.METRO_URL }]);
    expect(hostedCredentialsFor(orphan.id, cfg)).toEqual([]);
    writeFileSync(join(cfg, 'credentials.json'), JSON.stringify({ token: loginTokenFor(orphan.id), url: process.env.METRO_URL }));
    expect(hostedCredentialsFor(orphan.id, cfg).map((c) => c.token)).toEqual([loginTokenFor(orphan.id)]);
    expect(hostedCredentialsFor(tony.id, cfg).map((c) => c.token)).toEqual(['rt-tony']);
    writeFileSync(join(cfg, 'credentials.json'), JSON.stringify({ token: loginTokenFor(tony.id), url: process.env.METRO_URL }));
    expect(hostedCredentialsFor(tony.id, cfg).map((c) => c.token)).toEqual([loginTokenFor(tony.id), 'rt-tony']);
    rmSync(join(cfg, 'credentials.json'));
  });

  test('a stale runtime token from an old metro start does not hide a working metro login', async () => {
    const cfg = join(dir, 'config');
    forgetHostedConnectors();
    writeFileSync(join(cfg, `runtime-${tony.id}.json`), JSON.stringify({ token: 'rt-stale', url: process.env.METRO_URL }));
    writeFileSync(join(cfg, 'credentials.json'), JSON.stringify({ token: loginTokenFor(tony.id), url: process.env.METRO_URL }));
    const res = await get(`/api/agents/${tony.id}/connectors`);
    expect(((await res.json()) as { connectorIds: string[] }).connectorIds).toEqual(['conn0000001', 'conn0000002']);
    rmSync(join(cfg, 'credentials.json'));
    forgetHostedConnectors();
    const alone = await get(`/api/agents/${tony.id}/connectors`);
    expect(((await alone.json()) as { connectorIds: string[] }).connectorIds).toEqual([]);
    writeFileSync(join(cfg, `runtime-${tony.id}.json`), JSON.stringify({ token: 'rt-tony', url: process.env.METRO_URL }));
    forgetHostedConnectors();
  });

  test('the agent lists its metro.box connectors, and the agents list carries their ids', async () => {
    const res = await get(`/api/agents/${tony.id}/connectors`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: tony.id, name: 'Tony', connectorIds: ['conn0000001', 'conn0000002'] });
    const list = (await (await get(`/api/agents?project=${LOCAL_PROJECT_ID}`)).json()) as {
      agents: { id: string; connector_ids: string[] }[];
    };
    expect(list.agents.find((a) => a.id === tony.id)?.connector_ids).toEqual(['conn0000001', 'conn0000002']);
    expect(list.agents.find((a) => a.id === orphan.id)?.connector_ids).toEqual([]);
  });

  test('GET /api/connectors lists them in the shape the pages read, marked as managed on metro.box', async () => {
    const res = await get(`/api/connectors?project=${LOCAL_PROJECT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: Record<string, unknown>[] };
    expect(body.connectors.map((c) => c.name)).toEqual(['github', 'linear']);
    expect(body.connectors[0]).toMatchObject({ id: 'conn0000002', url: 'https://api.githubcopilot.com/mcp', auth: 'none', signIn: null, verified: null, managed: 'metro.box' });
    expect(body.connectors[1]).toMatchObject({ auth: 'oauth', signIn: 'connected' });
  });

  test('a stranger gets nothing, and the other connector routes say where connectors live', async () => {
    expect((await get(`/api/agents/${tony.id}/connectors`, STRANGER)).status).toBe(404);
    expect(((await (await get(`/api/connectors?project=${LOCAL_PROJECT_ID}`, STRANGER)).json()) as { connectors: unknown[] }).connectors).toEqual([]);
    expect((await get('/api/connectors/conn0000001')).status).toBe(404);
    expect((await fetch(`${base}/api/connectors`, { method: 'POST' })).status).toBe(405);
  });

  test('metro answers are cached for a minute, so the pages do not hammer metro.box', async () => {
    const before = asked.length;
    await get(`/api/agents/${tony.id}/connectors`);
    await get(`/api/connectors?project=${LOCAL_PROJECT_ID}`);
    expect(asked.length).toBe(before);
  });
});
