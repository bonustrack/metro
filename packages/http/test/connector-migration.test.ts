import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { rawPublicKey } from '../src/agent-signature.js';
import { combineConnectorPolicies, type ConnectorPolicy } from '../src/connector-delivery.js';
import { migrationPayloadOf, migrationRequestOf, migrationResponseOf, openConnectorMigration, sealConnectorMigration, type MigrationContext, type MigrationPayload } from '../src/connector-migration.js';
import { sealTransfer } from '../src/transfer-crypto.js';

const pair = generateKeyPairSync('x25519');
const publicKey = rawPublicKey(pair.publicKey);
const opaque = (): string => randomBytes(32).toString('base64url');
const context: MigrationContext = { owner: 'org_01TESTOWNER000000', agent: 'agent000001', keyId: opaque(), operationId: 'oper0000001', sourceId: 'local000001', destinationId: 'dest0000001' };
const payload: MigrationPayload = { name: 'Calendar', url: 'https://vendor.example/mcp?key=URL_SECRET', auth: { kind: 'header', name: 'Authorization', value: 'Bearer HEADER_SECRET' }, client: null, policy: { read: 'ask', write: 'deny', tools: { special: 'allow' } }, sourceStamp: opaque() };

describe('sealed connector migration', () => {
  test('only the receiving key and exact operation context can open source secrets', () => {
    const sealed = sealConnectorMigration(publicKey, context, payload);
    expect(openConnectorMigration(pair.privateKey, context, sealed)).toEqual(payload);
    expect(JSON.stringify(sealed)).not.toContain('SECRET');
    expect(sealConnectorMigration(publicKey, context, payload).ephemeralKey).not.toBe(sealed.ephemeralKey);
    for (const altered of [{ owner: 'org_01TESTOTHER000000' }, { agent: 'agent000002' }, { keyId: opaque() }, { operationId: 'oper0000002' }, { sourceId: 'local000002' }, { destinationId: 'dest0000002' }]) expect(() => openConnectorMigration(pair.privateKey, { ...context, ...altered }, sealed)).toThrow();
    expect(() => openConnectorMigration(generateKeyPairSync('x25519').privateKey, context, sealed)).toThrow();
    expect(() => openConnectorMigration(pair.privateKey, context, { ...sealed, tag: opaque() })).toThrow();
    expect(() => openConnectorMigration(pair.privateKey, context, { ...sealed, extra: true })).toThrow();
  });

  test('OAuth transfers intent and only configured manual client, never tokens or dynamic registration state', () => {
    const oauth = { ...payload, url: 'https://vendor.example/mcp', auth: { kind: 'oauth' }, client: { clientId: 'manual', clientSecret: 'MANUAL_SECRET' } };
    expect(migrationPayloadOf(oauth).auth).toEqual({ kind: 'oauth' });
    for (const auth of [{ kind: 'oauth', accessToken: 'OLD_ACCESS' }, { kind: 'oauth', refreshToken: 'OLD_REFRESH' }, { kind: 'oauth', clientId: 'dynamic' }, { kind: 'oauth', tokens: {} }]) expect(() => migrationPayloadOf({ ...oauth, auth })).toThrow();
    for (const change of [{ tokens: {} }, { url: 'https://vendor.example/oauth?key=URL_SECRET' }, { client: { clientId: 'dynamic', registrationAccessToken: 'SECRET' } }, { url: 'http://vendor.example/mcp' }, { policy: { write: 'sometimes' } }, { sourceStamp: 'not-a-stamp' }, { auth: { kind: 'none' } }]) expect(() => migrationPayloadOf({ ...oauth, ...change })).toThrow();
  });

  test('OAuth rejects raw private paths hidden by URL normalization before sealing and after decryption', () => {
    const urls = [
      'https://vendor.example/private-secret/../mcp',
      'https://vendor.example/private-secret/%2e%2e/mcp',
      'https://vendor.example/private-secret/%2E%2E/mcp',
      'https://vendor.example/private-secret/..',
      'https://vendor.example/private-secret/%2e%2e/',
      'https://vendor.example/private-secret\\..\\mcp',
      ' https://vendor.example/mcp',
      'https://vendor.example/mcp\n',
      'https://VENDOR.example/mcp',
      'https://vendor.example:443/mcp',
      'https://vendor.example/mcp?',
    ];
    const aad = Buffer.from(JSON.stringify(['metro-connector-migration/v1', context.owner, context.agent, context.keyId, context.operationId, context.sourceId, context.destinationId]));
    for (const url of urls) {
      const source = { ...payload, auth: { kind: 'oauth' as const }, url };
      expect(() => migrationPayloadOf(source)).toThrow('Invalid connector migration.');
      expect(() => sealConnectorMigration(publicKey, context, source)).toThrow('Invalid connector migration.');
      const unchecked = sealTransfer(publicKey, aad, Buffer.from(JSON.stringify(source)));
      expect(() => openConnectorMigration(pair.privateKey, context, unchecked)).toThrow('Invalid connector migration.');
    }
    for (const url of ['https://vendor.example', 'https://vendor.example/', 'https://vendor.example/mcp']) {
      expect(migrationPayloadOf({ ...payload, auth: { kind: 'oauth' }, url }).url).toBe(url);
    }
  });

  test('wire messages refuse extras, missing encryption and private material in responses', () => {
    const input = { action: 'begin', operationId: context.operationId, sourceId: context.sourceId };
    expect(migrationRequestOf(input)).toEqual(input);
    for (const patch of [{ action: 'prepare' }, { action: 'commit' }, { sealed: {} }, { operationId: 'invalid' }, { name: 'Calendar' }]) expect(() => migrationRequestOf({ ...input, ...patch })).toThrow();
    const response = { migration: { operationId: context.operationId, sourceId: context.sourceId, destinationId: context.destinationId, phase: 'preparing', readiness: 'pending', name: null, auth: null, policy: null, sourceStamp: null }, receiving: { publicKey, context } };
    expect(migrationResponseOf(response)).toEqual(response);
    expect(() => migrationResponseOf({ ...response, privateKey: 'PRIVATE' })).toThrow();
    expect(() => migrationResponseOf({ ...response, receiving: { publicKey, context, privateKey: 'PRIVATE' } })).toThrow();
    expect(() => migrationResponseOf({ ...response, receiving: { publicKey, context: { ...context, destinationId: 'dest0000002' } } })).toThrow();
  });
});

describe('exact migration policy preservation', () => {
  test('neutral assignments preserve every group and per-tool override without weakening independent restrictions', () => {
    const policies: ConnectorPolicy[] = [{}, { write: 'deny', tools: { special: 'ask' } }, { read: 'deny', write: 'deny', tools: { special: 'allow' } }, { read: 'ask', tools: { fetch: 'deny', write: 'allow' } }];
    for (const policy of policies) {
      expect(combineConnectorPolicies(policy, {})).toEqual(policy);
      expect(combineConnectorPolicies({}, policy)).toEqual(policy);
      expect(combineConnectorPolicies(policy, { read: 'allow', write: 'allow' })).toEqual(policy);
    }
    expect(combineConnectorPolicies({ write: 'deny', tools: { special: 'ask' } }, { tools: { special: 'deny' } }).tools?.special).toBe('deny');
  });
});
