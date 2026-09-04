import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { allowLocalConnectors } from '../src/daemon/connector-url.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { localSessionApis } from '../src/daemon/local-mode.ts';
import { ensureLocalSessionSecret } from '../src/daemon/local-secret.ts';
import { signSession } from '../src/daemon/session.ts';
import { claimLocalOwner, localCreateAgent, LOCAL_PROJECT_ID } from '../src/db/file-admin.ts';
import { setKeyMap } from '../src/db/key-map.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const STRANGER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const saved = {
  dir: process.env.METRO_AGENTS_DIR,
  secret: process.env.METRO_SESSION_SECRET,
  port: process.env.METRO_WEBHOOK_PORT,
  host: process.env.METRO_HTTP_HOST,
  pub: process.env.METRO_PUBLIC_URL,
};
let dir = '';
let secret = '';
let vendor: Server;
let vendorBase = '';
let daemon: Server;
let base = '';
let tony = { id: '', key: '' };
let suzy = { id: '', key: '' };
const seenAuth: string[] = [];

const rpc = (body: string): { method?: string; id?: number } => {
  try {
    return JSON.parse(body) as { method?: string; id?: number };
  } catch {
    return {};
  }
};

function speak(req: IncomingMessage, res: ServerResponse, body: string): void {
  seenAuth.push(req.headers.authorization ?? '');
  const { method, id } = rpc(body);
  const reply = (result: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, result }));
  };
  if (method === 'initialize')
    reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fakevendor', version: '1.0.0' } });
  else if (method === 'notifications/initialized') res.writeHead(202).end();
  else if (method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'says it back', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] });
  else res.writeHead(405).end();
}

const listen = (server: Server): Promise<string> =>
  new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-local-conn-'));
  process.env.METRO_AGENTS_DIR = dir;
  delete process.env.METRO_SESSION_SECRET;
  delete process.env.METRO_PUBLIC_URL;
  secret = ensureLocalSessionSecret(dir);
  setKeyMap([]);
  await claimLocalOwner(OWNER, dir);
  tony = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'Tony', dir);
  suzy = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'Suzy', dir);
  vendor = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      speak(req, res, body);
    });
  });
  vendorBase = await listen(vendor);
  process.env.METRO_WEBHOOK_PORT = String(10000 + Math.floor(Math.random() * 20000));
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  process.env.METRO_MODE = 'local';
  const apis = localSessionApis({
    syncStations: () => Promise.resolve(),
    closeAgentSession: () => Promise.resolve(true),
    gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }),
    capabilities: () => ({}),
    liveness: () => new Map(),
    prepareAccount: () => Promise.reject(new Error('not used')),
  });
  daemon = await startWebhookServer(makeEmit(), apis, async (_req, res) => {
    res.writeHead(404).end();
  });
  base = `http://127.0.0.1:${String((daemon.address() as AddressInfo).port)}`;
});

afterAll(() => {
  allowLocalConnectors(false);
});

afterAll(async () => {
  await new Promise<void>((done) => daemon.close(() => done()));
  vendor.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.METRO_MODE;
  for (const [k, v] of [
    ['METRO_AGENTS_DIR', saved.dir],
    ['METRO_SESSION_SECRET', saved.secret],
    ['METRO_WEBHOOK_PORT', saved.port],
    ['METRO_HTTP_HOST', saved.host],
    ['METRO_PUBLIC_URL', saved.pub],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const J = { 'content-type': 'application/json' };
const session = (subject = OWNER): string => signSession({ subject, agentIds: [] }, secret);
const call = (method: string, path: string, body?: unknown, token = session()): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : J) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

let linear = '';

describe('connectors on a local daemon, end to end through the real routes', () => {
  test('a connector on a loopback http url is accepted here, verified against the vendor, and stored in the files', async () => {
    const res = await call('POST', `/api/connectors?project=${LOCAL_PROJECT_ID}`, {
      name: 'linear',
      url: `${vendorBase}/mcp`,
      header: 'Authorization',
      value: 'Bearer vendor-secret',
    });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; name: string; verified: { server: string; tools: number } };
    linear = made.id;
    expect(made.verified).toMatchObject({ server: 'fakevendor', tools: 1 });
    expect(seenAuth).toContain('Bearer vendor-secret');
    const stored = JSON.parse(readFileSync(join(dir, 'connectors.json'), 'utf8')) as { connectors: { id: string; config: { auth: { value?: string } } }[] };
    expect(stored.connectors[0]?.id).toBe(linear);
    expect(stored.connectors[0]?.config.auth.value).toBe('Bearer vendor-secret');
    const list = (await (await call('GET', `/api/connectors?project=${LOCAL_PROJECT_ID}`)).json()) as { connectors: { id: string }[] };
    expect(list.connectors.map((c) => c.id)).toEqual([linear]);
  });

  test('agents hold connectors through their files; the same name twice on one agent is refused', async () => {
    const added = await call('POST', `/api/agents/${tony.id}/connectors`, { connectorId: linear });
    expect(added.status).toBe(200);
    expect(((await added.json()) as { connectorIds: string[] }).connectorIds).toEqual([linear]);
    const file = JSON.parse(readFileSync(join(dir, 'Tony', 'agent.json'), 'utf8')) as { connectors: string[] };
    expect(file.connectors).toEqual([linear]);
    const twin = (await (await call('POST', `/api/connectors?project=${LOCAL_PROJECT_ID}`, { name: 'linear', url: `${vendorBase}/other`, header: null, value: null })).json()) as { id: string };
    expect((await call('POST', `/api/agents/${tony.id}/connectors`, { connectorId: twin.id })).status).toBe(409);
    expect((await call('POST', `/api/agents/${suzy.id}/connectors`, { connectorId: twin.id })).status).toBe(200);
    const agents = (await (await call('GET', `/api/agents?project=${LOCAL_PROJECT_ID}`)).json()) as { agents: { id: string; connector_ids: string[] }[] };
    expect(agents.agents.find((a) => a.id === tony.id)?.connector_ids).toEqual([linear]);
    expect((await call('POST', `/api/connectors/${twin.id}/rename`, { name: 'jira' })).status).toBe(200);
    expect((await call('DELETE', `/api/connectors/${twin.id}`)).status).toBe(200);
    const suzyNow = (await (await call('GET', `/api/agents/${suzy.id}/connectors`)).json()) as { connectorIds: string[] };
    expect(suzyNow.connectorIds).toEqual([]);
  });

  test('the cli routes answer to the agent key with a relay block pointing at this daemon', async () => {
    const res = await fetch(`${base}/api/cli/mcp`, { headers: { authorization: `Bearer ${tony.key}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: string; agent: string };
    expect(body.agent).toBe('Tony');
    const block = JSON.parse(body.json) as { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> };
    const entry = block.mcpServers['metro.box linear'];
    expect(entry?.url).toBe(`http://127.0.0.1:${process.env.METRO_WEBHOOK_PORT ?? ''}/relay/${linear}`);
    expect(entry?.headers.Authorization).toBe(`Bearer ${tony.key}`);
    expect((await fetch(`${base}/api/cli/mcp`, { headers: { authorization: 'Bearer mk_wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/api/cli/session?token=${tony.key}`)).status).toBe(200);
    const summaries = (await (await fetch(`${base}/api/cli/connectors`, { headers: { authorization: `Bearer ${tony.key}` } })).json()) as { connectors: { name: string }[] };
    expect(summaries.connectors.map((c) => c.name)).toEqual(['linear']);
  });

  test('the relay proxies to the vendor with the stored credential, only for an agent holding the connector', async () => {
    const init = { jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } };
    const res = await fetch(`${base}/relay/${linear}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tony.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(init),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fakevendor');
    expect(seenAuth.at(-1)).toBe('Bearer vendor-secret');
    expect((await fetch(`${base}/relay/${linear}`, { method: 'POST', headers: { authorization: `Bearer ${suzy.key}`, 'content-type': 'application/json' }, body: JSON.stringify(init) })).status).toBe(404);
    expect((await fetch(`${base}/relay/${linear}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init) })).status).toBe(401);
  });

  test('a stranger sees nothing, and the vendor secret never comes back to a browser', async () => {
    expect((await call('GET', `/api/connectors?project=${LOCAL_PROJECT_ID}`, undefined, session(STRANGER))).status).toBe(404);
    const detail = await (await call('GET', `/api/connectors/${linear}`)).text();
    expect(detail).not.toContain('vendor-secret');
  });
});
