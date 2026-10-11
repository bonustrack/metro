import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomBytes, randomInt, type KeyObject } from 'node:crypto';
import { agentKeyId, rawPublicKey, signAgentRequest } from '@metro-labs/http/agent-signature';
import { openConnectorDelivery, type DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import { AgentAuth } from '../src/agents/auth.js';
import { handleAgentConnectorsRequest, type AgentConnectorsDeps } from '../src/agents/connectors.js';
import { sealConnectorSecret, type ConnectorSecret } from '../src/connectors/model.js';
import { agentKeyStore, type AgentKeyRow } from '../src/db/agent-keys.js';
import { agentNonceStore } from '../src/db/agent-nonces.js';
import type { Database } from '../src/db/client.js';
import { connectorDeliveryStore } from '../src/db/connector-delivery.js';
import type { ConnectorRow } from '../src/db/connectors.js';
import { connectorAgents, connectors } from '../src/db/schema.js';
import { addAgent } from './pglite-db.js';
import { TEST_OWNER } from './identity-helper.js';

export const HOST = 'api.metro.box';
export const PATH = '/api/agents/connectors';
export const CONN = 'conn0000001';
export const MASTER = randomBytes(32);
export const opaque = (): string => randomBytes(32).toString('base64url');

export interface DeliveryAgent {
  signing: KeyObject;
  sealing: KeyObject;
  row: AgentKeyRow;
}

export function newDeliveryAgent(agent = 'agent000001', owner = TEST_OWNER): DeliveryAgent {
  const signing = generateKeyPairSync('ed25519');
  const sealing = generateKeyPairSync('x25519');
  const signingKey = rawPublicKey(signing.publicKey);
  return {
    signing: signing.privateKey, sealing: sealing.privateKey,
    row: { agent, owner, keyId: agentKeyId(signingKey), signingKey, sealingKey: rawPublicKey(sealing.publicKey), enrolledBy: 'user_01TEST', enrolledAt: new Date().toISOString() },
  };
}

export async function enrollDeliveryAgent(db: Database, agent: DeliveryAgent): Promise<void> {
  await addAgent(db, agent.row.agent, agent.row.owner);
  await agentKeyStore(() => db).enroll(agent.row);
}

export function oauthSecret(expiresAt = Date.now() - 1): Extract<ConnectorSecret, { kind: 'oauth' }> {
  return {
    kind: 'oauth', targetUrl: 'https://vendor.example/mcp?key=URL_SECRET',
    server: { issuer: 'https://vendor.example', authorizationEndpoint: 'https://vendor.example/authorize', tokenEndpoint: 'https://vendor.example/token', registrationEndpoint: null, supportsS256: true, scopes: ['read', 'write'] },
    client: { clientId: 'CLIENT_ID', clientSecret: 'CLIENT_SECRET' },
    tokens: { accessToken: 'ACCESS_OLD', refreshToken: 'REFRESH_OLD', expiresAt },
  };
}

export async function seedConnector(db: Database, secret: ConnectorSecret, patch: Partial<ConnectorRow> = {}): Promise<ConnectorRow> {
  const at = new Date().toISOString();
  const row: ConnectorRow = { id: CONN, owner: TEST_OWNER, name: 'Calendar', url: 'https://vendor.example', auth: secret.kind, authGeneration: 'generation1', policy: null, secret: null, detail: secret.kind === 'oauth' && secret.tokens !== undefined ? JSON.stringify({ signedInAt: at }) : null, createdBy: 'user_01TEST', createdAt: at, updatedAt: at, ...patch };
  row.secret = sealConnectorSecret(MASTER, row, secret);
  await db.insert(connectors).values(row);
  return row;
}

export async function assignConnector(db: Database, agent: DeliveryAgent, connector = CONN, policy: string | null = null): Promise<void> {
  await db.insert(connectorAgents).values({ connector, agent: agent.row.agent, policy, createdBy: 'user_01TEST', createdAt: new Date().toISOString() });
}

export function signedDelivery(agent: DeliveryAgent, input: unknown, now = Date.now(), path = PATH, host = HOST): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(input);
  return { body, headers: { 'content-type': 'application/json', authorization: signAgentRequest({ method: 'POST', host, path, body: Buffer.from(body) }, agent.signing, agent.row.keyId, now) } };
}

export async function startDeliveryApi(db: Database, overrides: Partial<AgentConnectorsDeps> = {}) {
  const deps: AgentConnectorsDeps = { enabled: () => true, deliveryEnabled: () => true, key: () => MASTER, keys: agentKeyStore(() => db), nonces: agentNonceStore(() => db, Date.now), store: connectorDeliveryStore(() => db), auth: new AgentAuth(HOST, Date.now), fetch: () => Promise.resolve(Response.json({ access_token: 'ACCESS_NEW', refresh_token: 'REFRESH_NEW', expires_in: 3600 })), now: Date.now, ...overrides };
  const server = createServer((req, res) => {
    if (!handleAgentConnectorsRequest(req, res, deps)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    deps, base,
    call: (agent: DeliveryAgent, input: unknown = { requestId: opaque() }, headers: Record<string, string> = {}) => {
      const request = signedDelivery(agent, input, deps.now());
      return fetch(`${base}${PATH}`, { method: 'POST', ...request, headers: { ...request.headers, ...headers } });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function openResponse(response: Response, agent: DeliveryAgent, requestId: string): Promise<DeliverySnapshot> {
  const answer = await response.json() as { sealed: unknown };
  return openConnectorDelivery(agent.sealing, { owner: agent.row.owner, agent: agent.row.agent, keyId: agent.row.keyId, requestId }, answer.sealed);
}

export function latch(): { reached: Promise<void>; pause: () => Promise<void>; release: () => void } {
  const entered = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  return { reached: entered.promise, pause: () => { entered.resolve(); return waiting.promise; }, release: () => waiting.resolve() };
}
