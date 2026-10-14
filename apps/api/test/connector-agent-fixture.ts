import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { agentKeyId, rawPublicKey } from '@metro-labs/http/agent-signature';
import { sealConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import { agentKeyStore, type AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import type { Database } from '../src/db/client.js';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { connectorAgents, connectors } from '../src/db/schema.js';
import { addAgent } from './pglite-db.js';
import { TEST_OWNER } from './identity-helper.js';

export const CONN = 'conn0000001';
export const MASTER = randomBytes(32);
export const opaque = (): string => randomBytes(32).toString('base64url');

export interface EnrolledAgent {
  row: AgentKeyRow;
}

export function newEnrolledAgent(agent = 'agent000001', owner = TEST_OWNER): EnrolledAgent {
  const signingKey = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
  return {
    row: { agent, owner, keyId: agentKeyId(signingKey), signingKey, sealingKey: rawPublicKey(generateKeyPairSync('x25519').publicKey), enrolledBy: 'user_01TEST', enrolledAt: new Date().toISOString() },
  };
}

export async function enrollAgent(db: Database, agent: EnrolledAgent): Promise<void> {
  await addAgent(db, agent.row.agent, agent.row.owner);
  await agentKeyStore(() => db).enroll(agent.row);
}

export async function enrollLegacyAgent(db: Database, agent: EnrolledAgent): Promise<void> {
  const { agent: id, owner, keyId, signingKey, sealingKey, enrolledBy, enrolledAt } = agent.row;
  await addAgent(db, id, owner);
  await db.execute(sql`INSERT INTO agent_keys (agent, owner, key_id, signing_key, sealing_key, enrolled_by, enrolled_at) VALUES (${id}, ${owner}, ${keyId}, ${signingKey}, ${sealingKey}, ${enrolledBy}, ${enrolledAt})`);
}

export function oauthSecret(expiresAt = Date.now() - 1): Extract<ConnectorSecret, { kind: 'oauth' }> {
  return {
    kind: 'oauth', targetUrl: 'https://vendor.example/mcp?key=URL_SECRET',
    server: { issuer: 'https://vendor.example', authorizationEndpoint: 'https://vendor.example/authorize', tokenEndpoint: 'https://vendor.example/token', registrationEndpoint: null, supportsS256: true, scopes: ['read', 'write'] },
    client: { clientId: 'CLIENT_ID', clientSecret: 'CLIENT_SECRET' },
    oauthResource: 'https://vendor.example/mcp',
    tokens: { accessToken: 'ACCESS_OLD', refreshToken: 'REFRESH_OLD', expiresAt, resource: 'https://vendor.example/mcp' },
  };
}

export async function seedConnector(db: Database, secret: ConnectorSecret, patch: Partial<ConnectorRow> = {}): Promise<ConnectorRow> {
  const at = new Date().toISOString();
  const row: ConnectorRow = { id: CONN, owner: TEST_OWNER, name: 'Calendar', url: 'https://vendor.example', auth: secret.kind, authGeneration: 'generation1', policy: null, secret: null, detail: secret.kind === 'oauth' && secret.tokens !== undefined ? JSON.stringify({ signedInAt: at }) : null, createdBy: 'user_01TEST', createdAt: at, updatedAt: at, ...patch };
  row.secret = sealConnectorSecret(MASTER, row, secret);
  await db.insert(connectors).values(row);
  return row;
}

export async function assignConnector(db: Database, agent: EnrolledAgent, connector = CONN, policy: string | null = null): Promise<void> {
  await db.insert(connectorAgents).values({ connector, agent: agent.row.agent, policy, createdBy: 'user_01TEST', createdAt: new Date().toISOString() });
}

export async function seedLegacyMigration(db: Database, agent: EnrolledAgent, destination: string, operation = 'oper0000001'): Promise<void> {
  const at = new Date().toISOString();
  const { owner, agent: id, keyId, signingKey, sealingKey, enrolledAt } = agent.row;
  await db.execute(sql`INSERT INTO connector_migrations (id, owner, agent, source_id, operation_id, destination_id, key_id, signing_key, sealing_key, enrolled_at, phase, receiving_key, receiving_secret, snapshot, config_stamp, retired_operations, created_at, updated_at) VALUES ('migr0000001', ${owner}, ${id}, 'local000001', ${operation}, ${destination}, ${keyId}, ${signingKey}, ${sealingKey}, ${enrolledAt}, 'active', 'receiving-public-key', 'receiving-sealed-secret', null, null, '[]', ${at}, ${at})`);
  await db.execute(sql`UPDATE connector_agents SET migration_operation = ${operation} WHERE connector = ${destination} AND agent = ${id}`);
}

export function latch(): { reached: Promise<void>; pause: () => Promise<void>; release: () => void } {
  const entered = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  return { reached: entered.promise, pause: () => { entered.resolve(); return waiting.promise; }, release: () => waiting.resolve() };
}
