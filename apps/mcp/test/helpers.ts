import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, randomInt, type KeyObject } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { agentKeyId, rawPublicKey, signAgentRequest } from '@metro-labs/http/agent-signature';
import { agentKeyStore, type AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import type { Database } from '@metro-labs/connectors/db/database';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { sealConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import * as schema from '@metro-labs/connectors/db/schema';
import { handleRequest, mcpDeps } from '../src/app.ts';
import type { McpDeps } from '../src/deps.ts';
import { tokenHashOf } from '@metro-labs/connectors/db/agent-tokens';

export const PGLITE_START_MS = 60_000;
export const OWNER = 'org_01TESTOWNER000000';
export const STRANGER = 'org_01TESTSTRANGER00';
export const HOST = 'mcp.metro.box';
export const MASTER = randomBytes(32);
export const VENDOR_ORIGIN = 'https://vendor.example.com';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'drizzle');
const TABLES = ['model_calls', 'model_windows', 'mcp_calls', 'mcp_approvals', 'agent_nonces', 'agent_tokens', 'agent_keys', 'connector_agents', 'connectors', 'agents'];

export interface TestDb {
  db: Database;
  client: PGlite;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function testDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return {
    db,
    client,
    reset: async () => {
      await client.exec(`TRUNCATE ${TABLES.map((table) => `"${table}"`).join(', ')} CASCADE`);
    },
    close: async () => {
      await client.close();
    },
  };
}

export interface TestAgent {
  signing: KeyObject;
  row: AgentKeyRow;
  token: string;
}

export const newToken = (): string => `mcp_${randomBytes(32).toString('base64url')}`;

export async function enrollAgent(db: Database, agent: string, owner = OWNER): Promise<TestAgent> {
  const signing = generateKeyPairSync('ed25519');
  const signingKey = rawPublicKey(signing.publicKey);
  const row: AgentKeyRow = { agent, owner, keyId: agentKeyId(signingKey), signingKey, enrolledBy: 'user_01TEST', enrolledAt: new Date().toISOString() };
  await db.insert(schema.agents).values({ id: agent, owner, host: `${agent.toLowerCase()}.tail0000.ts.net`, addedAt: '2026-10-14T00:00:00.000Z', slug: agent.toLowerCase() });
  await agentKeyStore(() => db).enroll(row);
  const token = newToken();
  await db.update(schema.agentKeys).set({ mcpTokenHash: tokenHashOf(token) }).where(eq(schema.agentKeys.agent, agent));
  return { signing: signing.privateKey, row, token };
}

export async function addConnector(db: Database, id: string, name: string, secret: ConnectorSecret, patch: Partial<ConnectorRow> = {}): Promise<ConnectorRow> {
  const at = new Date().toISOString();
  const row: ConnectorRow = { id, owner: OWNER, name, url: VENDOR_ORIGIN, auth: secret.kind, authGeneration: 'generation1', policy: null, secret: null, detail: null, createdBy: 'user_01TEST', createdAt: at, updatedAt: at, ...patch };
  row.secret = sealConnectorSecret(MASTER, row, secret);
  await db.insert(schema.connectors).values(row);
  return row;
}

export async function assign(db: Database, connector: string, agent: string, policy: string | null = null): Promise<void> {
  await db.insert(schema.connectorAgents).values({ connector, agent, policy, createdBy: 'user_01TEST', createdAt: new Date().toISOString() });
}

export const headerSecret = (path = '/mcp', value = 'Bearer VENDOR_KEY'): ConnectorSecret => ({ kind: 'header', targetUrl: `${VENDOR_ORIGIN}${path}`, name: 'Authorization', value });

export function signed(agent: TestAgent, path: string, input: unknown, now = Date.now()): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(input);
  return { body, headers: { 'content-type': 'application/json', authorization: signAgentRequest({ method: 'POST', host: HOST, path, body: Buffer.from(body) }, agent.signing, agent.row.keyId, now) } };
}

export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { server, base, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

export function rewrite(base: string): FetchLike {
  return (input, init) => fetch(String(input).replace(VENDOR_ORIGIN, base), init);
}

export interface TestApp {
  deps: McpDeps;
  base: string;
  close: () => Promise<void>;
}

export async function startApp(db: Database, fetchImpl: FetchLike, overrides: Partial<McpDeps> = {}): Promise<TestApp> {
  const deps = { ...mcpDeps({ key: MASTER, db: () => db, publicHost: HOST, fetch: fetchImpl, callFetch: fetchImpl, ...(overrides.now === undefined ? {} : { now: overrides.now }) }), ...overrides };
  const started = await listen((req, res) => {
    handleRequest(req, res, deps);
  });
  return { deps, base: started.base, close: started.close };
}

export async function rpc(app: TestApp, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers }, body: JSON.stringify(body) });
}

export interface CallAnswer {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export async function callTool(app: TestApp, token: string, name: string, args: unknown): Promise<CallAnswer> {
  const res = await rpc(app, token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  const body = await res.json() as { result: CallAnswer };
  return body.result;
}

export const texts = (result: { content: { type: string; text?: string }[] }): string[] => result.content.map((block) => block.text ?? '');
