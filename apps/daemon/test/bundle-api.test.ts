import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSessionApis } from '../src/routes/local-mode.ts';
import { handleSessionApis, type SessionApis } from '../src/routes/session-apis.ts';
import { agentIdForKey, setKeyMap } from '../src/agents/keys.ts';
import { localAttachAccount, localCreateAgent, LOCAL_PROJECT_ID, setLocalOwner } from '../src/agents/file-admin.ts';
import { localImportConnectors, readLocalConnectors } from '../src/connectors/store.ts';
import { parseBundle } from '../src/agents/bundle.ts';
import { auth, TEST_STRANGER, type Who } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const STRANGER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const saved = { dir: process.env.METRO_AGENTS_DIR };
let dir = '';
let server: Server;
let base = '';
const synced: string[] = [];
let tony = { id: '', key: '' };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-bundle-'));
  process.env.METRO_AGENTS_DIR = dir;
  setKeyMap([]);
  setLocalOwner(OWNER, dir);
  const made = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'Tony', dir);
  tony = { id: made.id, key: made.key };
  await localAttachAccount(OWNER, tony.id, 'telegram-bot', { token: 'bot-token' }, dir);
  localImportConnectors(
    [{ id: 'conn0000001', name: 'linear', url: 'https://mcp.linear.app/mcp', transport: 'http', config: { auth: { kind: 'header', name: 'Authorization', value: 'Bearer vendor' }, createdAt: '2026-09-01T00:00:00.000Z', verified: { at: '2026-09-01T00:00:00.000Z', server: 'linear', tools: [] } } }],
    dir,
  );
  const apis: SessionApis = localSessionApis({
    syncStations: (station) => {
      synced.push(station);
      return Promise.resolve();
    },
    restart: () => undefined,
    stop: () => undefined,
    gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }),
    capabilities: () => ({}),
    liveness: () => new Map(),
    prepareAccount: (input) => Promise.resolve({ config: { token: String(input.token) }, identity: { handle: '@bot' } }),
  });
  server = createServer((req, res) => {
    if (handleSessionApis(req, res, apis)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
  process.env.METRO_AGENTS_DIR = saved.dir;
  rmSync(dir, { recursive: true, force: true });
});

const session = (subject = OWNER): string => subject;
const call = async (method: string, path: string, body?: unknown, token: Who = session()): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(method, path, token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('an agent bundle on a local daemon', () => {
  test('the owner reads the whole agent as one plaintext bundle: file, stations, connectors and credentials', async () => {
    const res = await call('GET', `/api/agents/${tony.id}/bundle`);
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as { version: number; agent: { id: string; name: string; key: string; stations: { station: string; config: { token: string } }[] }; connectors: { id: string; config: { auth: { value: string } } }[] };
    expect(bundle.version).toBe(1);
    expect(bundle.agent).toMatchObject({ id: tony.id, name: 'Tony', key: tony.key });
    expect(bundle.agent.stations.map((a) => [a.station, a.config.token])).toEqual([['telegram-bot', 'bot-token']]);
    expect(bundle.connectors.map((c) => [c.id, c.config.auth.value])).toEqual([['conn0000001', 'Bearer vendor']]);
    expect((await call('GET', `/api/agents/${tony.id}/bundle`, undefined, session(STRANGER))).status).toBe(404);
    expect((await fetch(`${base}/api/agents/${tony.id}/bundle`)).status).toBe(401);
    expect((await call('POST', `/api/agents/${tony.id}/bundle`, {})).status).toBe(405);
  });

  test('restoring that bundle on an empty daemon brings the agent back: same id, key, stations and connectors', async () => {
    const bundle = (await (await call('GET', `/api/agents/${tony.id}/bundle`)).json()) as { agent: { stations: { station: string }[] } };
    const restored = parseBundle(bundle);
    expect(restored.agent.stations.map((a) => a.station)).toEqual(['telegram-bot']);
    rmSync(join(dir, 'agent.json'), { force: true });
    rmSync(join(dir, 'connectors.json'), { force: true });
    setKeyMap([]);
    expect(agentIdForKey(tony.key)).toBeUndefined();
    const res = await call('POST', '/api/agents/restore', bundle);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: tony.id, name: 'Tony', stations: 1, connectors: 1 });
    expect(agentIdForKey(tony.key)).toBe(tony.id);
    const file = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as { id: string; key: string; connectors: string[]; stations: { config: { token: string } }[] };
    expect(file).toMatchObject({ id: tony.id, key: tony.key, connectors: [] });
    expect(file.stations[0]?.config.token).toBe('bot-token');
    expect(existsSync(join(dir, 'connectors.json'))).toBe(true);
    expect(synced).toContain('telegram-bot');
    expect((await call('POST', '/api/agents/restore', { version: 2 })).status).toBe(400);
    expect((await call('POST', '/api/agents/restore', bundle, session(STRANGER))).status).toBe(404);
  });

  test('append leaves what is already here alone; overwrite replaces the match', async () => {
    const read = (): { stations: { station: string; id: string; config: { token: string } }[] } =>
      JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as {
        stations: { station: string; id: string; config: { token: string } }[];
      };
    const here = read().stations[0];
    if (here === undefined) throw new Error('expected a station to be here already');

    const incoming = {
      version: 1,
      agent: { id: tony.id, name: 'Tony', key: tony.key, stations: [{ ...here, config: { token: 'from-the-file' } }] },
      connectors: [],
    };

    expect((await call('POST', '/api/agents/restore', { ...incoming, mode: 'append' })).status).toBe(201);
    expect(read().stations[0]?.config.token).toBe('bot-token');

    expect((await call('POST', '/api/agents/restore', { ...incoming, mode: 'overwrite' })).status).toBe(201);
    expect(read().stations[0]?.config.token).toBe('from-the-file');

    const other = {
      ...incoming,
      agent: {
        ...incoming.agent,
        stations: [{ ...here, id: `${here.id.slice(0, -8)}deadbeef`, config: { token: 'a-second' } }],
      },
    };
    expect((await call('POST', '/api/agents/restore', { ...other, mode: 'append' })).status).toBe(201);
    const after = read().stations;
    expect(after).toHaveLength(2);
    expect(after.map((a) => a.config.token).sort()).toEqual(['a-second', 'from-the-file']);

    expect((await call('POST', '/api/agents/restore', { ...incoming, mode: 'sideways' })).status).toBe(400);
  });

  test('a connector with the same name but another id: append leaves the one here, overwrite replaces it', async () => {
    const before = readLocalConnectors(dir).find((c) => c.name === 'linear');
    if (before === undefined) throw new Error('expected the linear connector to be here');
    const twin = { id: 'conn0000002', name: 'linear', url: 'https://mcp.linear.app/other', transport: 'http', config: {} };
    const body = { version: 1, agent: { id: tony.id, name: 'Tony', key: tony.key, stations: [] }, connectors: [twin] };
    expect((await call('POST', '/api/agents/restore', { ...body, mode: 'append' })).status).toBe(201);
    expect(readLocalConnectors(dir).filter((c) => c.name === 'linear').map((c) => c.id)).toEqual([before.id]);
    expect((await call('POST', '/api/agents/restore', { ...body, mode: 'overwrite' })).status).toBe(201);
    const after = readLocalConnectors(dir).filter((c) => c.name === 'linear');
    expect(after.map((c) => c.id)).toEqual(['conn0000002']);
    expect(after[0]?.url).toBe('https://mcp.linear.app/other');
  });
});
