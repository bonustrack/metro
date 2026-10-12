import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { migrationResponseOf, sealConnectorMigration, type MigrationPayload, type MigrationResponse } from '@metro-labs/http/connector-migration';
import { AgentAuth } from '../src/agents/auth.js';
import { handleAgentMigrationsRequest, type AgentMigrationsDeps } from '../src/agents/connector-migrations.js';
import { OwnerTickets } from '../src/agents/tickets.js';
import type { Handoff, SignInState } from '../src/connectors/sign-in.js';
import { agentKeyStore } from '../src/db/agent-keys.js';
import { agentNonceStore } from '../src/db/agent-nonces.js';
import type { Database } from '../src/db/client.js';
import { connectorMigrationStore } from '../src/db/connector-migrations.js';
import { HOST, MASTER, opaque, signedDelivery, type DeliveryAgent } from './connector-delivery-fixture.js';
import { CALLBACK, GOOD_KEY } from './org-connectors-fixture.js';

export const MIGRATION_PATH = '/api/agents/connector-migrations';
export const OPERATION = 'oper0000001';
export const SOURCE = 'local000001';
export const input = (action: string, operationId = OPERATION, sourceId = SOURCE) => ({ action, operationId, sourceId });
export const payload = (patch: Partial<MigrationPayload> = {}): MigrationPayload => ({ name: 'Calendar', url: 'https://vendor.example/keyed?key=URL_SECRET', auth: { kind: 'header', name: 'Authorization', value: GOOD_KEY }, client: null, policy: { write: 'deny', tools: { special: 'ask' } }, sourceStamp: opaque(), ...patch });
export const verifiedFetch: FetchLike = () => Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'Fixture MCP' } } }));

export async function startMigrationApi(db: Database, overrides: Partial<AgentMigrationsDeps> = {}) {
  const deps: AgentMigrationsDeps = { enabled: () => true, deliveryEnabled: () => true, key: () => MASTER, keys: agentKeyStore(() => db), nonces: agentNonceStore(() => db, Date.now), migrations: connectorMigrationStore(() => db), auth: new AgentAuth(HOST, Date.now), fetch: verifiedFetch, now: Date.now, httpsOnly: true, callbackUrl: CALLBACK, states: new OwnerTickets<SignInState>((state) => state.connector, { what: 'migration sign-ins' }), handoffs: new OwnerTickets<Handoff>((handoff) => handoff.connector, { what: 'migration sign-ins' }), ...overrides };
  const server = createServer((req, res) => {
    if (!handleAgentMigrationsRequest(req, res, deps)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    deps, base,
    call: (agent: DeliveryAgent, body: unknown, headers: Record<string, string> = {}) => {
      const request = signedDelivery(agent, body, deps.now(), MIGRATION_PATH);
      return fetch(`${base}${MIGRATION_PATH}`, { method: 'POST', ...request, headers: { ...request.headers, ...headers } });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type MigrationApi = Awaited<ReturnType<typeof startMigrationApi>>;

export async function answer(response: Response): Promise<MigrationResponse> {
  if (response.status !== 200) throw new Error(`Migration returned ${String(response.status)}: ${await response.text()}`);
  return migrationResponseOf(await response.json());
}

export function prepareInput(begin: MigrationResponse, source: MigrationPayload) {
  if (begin.receiving === undefined) throw new Error('missing receiving context');
  return { ...input('prepare', begin.migration.operationId, begin.migration.sourceId), sealed: sealConnectorMigration(begin.receiving.publicKey, begin.receiving.context, source) };
}

export async function prepared(api: MigrationApi, agent: DeliveryAgent, source = payload()): Promise<MigrationResponse> {
  const begin = await answer(await api.call(agent, input('begin')));
  return answer(await api.call(agent, prepareInput(begin, source)));
}
