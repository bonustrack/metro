import { expect } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { agentSignatureValid, rawPublicKey, readAgentProof } from '@metro-labs/http/agent-signature';
import { migrationRequestOf, openConnectorMigration, type MigrationContext, type MigrationPayload, type MigrationView } from '@metro-labs/http/connector-migration';
import type { DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import { newAgentKey } from '../src/connectors/agent-key.ts';
import { ConnectorMigrations } from '../src/connectors/migration-control.ts';
import { localRollbackMigrationSource } from '../src/connectors/store.ts';

export const OWNER = 'org_01MIGRATIONOWNER00';
export const SOURCE = 'conn0000001';
export const DESTINATION = 'dest0000001';
const AGENT = 'apiagent001';

export function migrationFixture(oauth = false) {
  const dir = mkdtempSync(join(tmpdir(), 'metro-migration-control-'));
  const key = { ...newAgentKey(), enrollment: { organization: OWNER, server: AGENT, at: '' } };
  const source = {
    id: SOURCE, name: 'Example', url: oauth ? 'https://mcp.example.com/mcp' : 'https://mcp.example.com/private?key=url-fixture-secret',
    config: {
      createdAt: '', verified: { at: '', server: '' }, oauth, client: oauth ? { clientId: 'manual-client', clientSecret: 'manual-fixture-secret' } : null,
      auth: oauth ? { kind: 'oauth', accessToken: 'access-fixture-secret', refreshToken: 'refresh-fixture-secret', clientId: 'local-dynamic-client', tokenEndpoint: 'https://auth.example.com/token', issuer: 'https://auth.example.com', expiresAt: 1 } : { kind: 'header', name: 'X-Test-Key', value: 'header-fixture-secret' },
      policy: { read: 'ask', write: 'deny', tools: { special: 'ask' } },
    },
  };
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [source] }));
  const receiving = generateKeyPairSync('x25519');
  const status: ConnectorSyncStatus = { owner: OWNER, agentId: AGENT, scope: 'a'.repeat(64), enrolled: true, enabled: true, source: 'saved', state: 'waiting', liveEnabled: false, lastReceivedAt: null, leaseExpiresAt: null, counts: null };
  let remote: MigrationView | null = null;
  let payload: MigrationPayload | null = null;
  const requests: string[] = [];
  const controls = { localIdle: true, orgIdle: true, freshFail: false, drop: '', pause: null as Promise<void> | null, creates: 0, assignments: 0, rollbacks: 0, restored: 0 };
  const readSource = () => readFileSync(join(dir, 'connectors.json'), 'utf8');
  const context = (operationId: string): MigrationContext => ({ owner: OWNER, agent: AGENT, keyId: key.keyId, operationId, sourceId: SOURCE, destinationId: DESTINATION });
  const api = {
    base: 'https://api.example.com', now: () => Date.now(),
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      const proof = readAgentProof(new Headers(init.headers).get('authorization') ?? undefined);
      if (proof === null) throw new Error('missing signature');
      const body = String(init.body);
      expect(agentSignatureValid({ method: 'POST', host: new URL(url).host, path: new URL(url).pathname, body: Buffer.from(body) }, proof, key.signingKey)).toBe(true);
      requests.push(body);
      const request = migrationRequestOf(JSON.parse(body));
      if (controls.pause !== null) await controls.pause;
      if (remote === null) remote = { operationId: request.operationId, sourceId: SOURCE, destinationId: DESTINATION, phase: 'preparing', readiness: 'pending', name: null, auth: null, policy: null, sourceStamp: null };
      if (request.action === 'prepare') {
        payload = openConnectorMigration(receiving.privateKey, context(request.operationId), request.sealed);
        if (remote.phase === 'preparing') controls.creates += 1;
        remote = { ...remote, phase: 'prepared', readiness: oauth ? 'signin' : 'ready', name: payload.name, auth: payload.auth.kind, policy: payload.policy, sourceStamp: payload.sourceStamp };
      }
      if (request.action === 'activate') {
        if (remote.phase !== 'active') controls.assignments += 1;
        remote = { ...remote, phase: 'active' };
      }
      if (request.action === 'rollback') {
        if (remote.phase !== 'rolled_back') controls.rollbacks += 1;
        remote = { ...remote, phase: 'rolled_back' };
      }
      if (controls.drop === request.action) { controls.drop = ''; throw new Error('connection closed after database commit'); }
      return Response.json({ migration: remote, ...(request.action === 'begin' ? { receiving: { publicKey: rawPublicKey(receiving.publicKey), context: context(request.operationId) } } : {}) });
    },
  };
  const fresh = (): Promise<DeliverySnapshot> => {
    if (controls.freshFail || payload === null) return Promise.reject(new Error('no decrypted receipt'));
    return Promise.resolve({ issuedAt: Date.now(), expiresAt: Date.now() + 60_000, connectors: [{ id: DESTINATION, name: payload.name, url: payload.url, auth: payload.auth.kind, headers: {}, policy: payload.policy, state: 'ready', revision: 'r'.repeat(43) }] });
  };
  const control = () => new ConnectorMigrations({
    dir, api, key: () => key, status: () => status, fresh, changed: () => {}, localIdle: () => controls.localIdle, orgIdle: () => controls.orgIdle,
    restore: (id, signOut) => { controls.restored += 1; localRollbackMigrationSource(id, signOut, dir); },
  });
  return { dir, key, source, status, controls, requests, readSource, control, remote: () => remote, payload: () => payload, ready: () => { if (remote !== null) remote.readiness = 'ready'; } };
}
