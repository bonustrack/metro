import { randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readBodyBytes } from '@metro-labs/http/api-http';
import { agentSignatureValid, readAgentProof } from '@metro-labs/http/agent-signature';
import { newAgentKey, type AgentKey } from '../src/connectors/agent-key.ts';
import type { MetroApi } from '../src/connectors/metro-api.ts';
import { OrgModels } from '../src/gateway/org-models.ts';

export const OWNER = 'org_01AGENTOWNER00000';
export const AGENT = 'agent000001';

export interface Asked {
  path: string;
  body: Record<string, unknown>;
}

export interface FakeApi {
  base: string;
  asked: Asked[];
  delivery: Record<string, unknown>;
  answer: ((path: string, body: Record<string, unknown>) => { status: number; body: unknown } | 'drop' | null) | null;
  imported: Map<string, string>;
  close: () => Promise<void>;
}

export const keyCredential = (apiKey: string): Record<string, unknown> => ({ apiKey });

export function deliveredRow(id: string, provider: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, provider, label: provider, model: '', region: '', zdr: false, revision: 1, account: { email: null, plan: null, method: null }, credential: null, ...fields };
}

export const delivery = (primary: { connection: string; model: string } | null, connections: Record<string, unknown>[], fallbacks: { connection: string; model: string }[] = [], source = 'organization'): Record<string, unknown> => ({
  route: primary === null ? null : { primary, fallbacks },
  source: primary === null ? null : source,
  connections,
  chatgptHostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
});

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function localOf(row: Record<string, unknown>): string | null {
  if (row.provider !== 'anthropic') return null;
  const login = row.claude;
  if (typeof login === 'object' && login !== null && 'id' in login) return `local:${String(login.id)}`;
  return 'apiKey' in row ? null : 'local:session';
}

function importAnswer(api: FakeApi, body: Record<string, unknown>): Record<string, unknown> {
  const rows: unknown[] = Array.isArray(body.connections) ? body.connections : [];
  const ids: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const entry = row as Record<string, unknown>;
    const old = String(entry.id);
    const local = localOf(entry);
    if (local === null && !api.imported.has(old)) api.imported.set(old, `new${String(api.imported.size).padStart(8, '0')}`);
    ids[old] = local ?? api.imported.get(old) ?? '';
  }
  return { ids };
}

export async function fakeApi(key: AgentKey): Promise<FakeApi> {
  const api: FakeApi = { base: '', asked: [], delivery: delivery(null, []), answer: null, imported: new Map(), close: () => Promise.resolve() };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const bytes = await readBodyBytes(req, 256 * 1024);
    const path = req.url ?? '';
    const body = bytes.length === 0 ? {} : (JSON.parse(bytes.toString('utf8')) as Record<string, unknown>);
    const proof = readAgentProof(req.headers.authorization);
    if (proof === null || !agentSignatureValid({ method: req.method ?? '', host: req.headers.host ?? '', path, body: bytes }, proof, key.signingKey)) {
      send(res, 401, { error: 'not signed', code: 'agent_key_missing' });
      return;
    }
    api.asked.push({ path, body });
    const custom = api.answer?.(path, body) ?? null;
    if (custom === 'drop') {
      req.socket.destroy();
      return;
    }
    if (custom !== null) send(res, custom.status, custom.body);
    else if (path === '/api/agents/models') send(res, 200, api.delivery);
    else if (path === '/api/agents/models/import') send(res, 200, importAnswer(api, body));
    else send(res, 404, { error: 'not found' });
  };
  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      send(res, 500, { error: 'fake api failed' });
    });
  });
  const port = randomInt(10000, 30000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  api.base = `http://127.0.0.1:${String(port)}`;
  api.close = () => new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return api;
}

export const enrolledKey = (): AgentKey => ({ ...newAgentKey(), enrollment: { server: AGENT, organization: OWNER, at: '2026-10-09T00:00:00.000Z' } });

export const metroApi = (base: string): MetroApi => ({ base, fetch: (url, init) => fetch(url, init), now: () => Date.now() });

export function orgModelsFor(api: FakeApi, key: AgentKey | null, dir: string, owner: string | null = OWNER): OrgModels {
  return new OrgModels({ owner: () => owner, key: () => key, api: metroApi(api.base), dir: () => dir });
}
