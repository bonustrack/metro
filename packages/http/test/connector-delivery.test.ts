import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { rawPublicKey } from '../src/agent-signature.js';
import { CONNECTOR_DELIVERY_LEASE_MS, CONNECTOR_DELIVERY_MAX_BYTES, combineConnectorPolicies, connectorPolicyOf, deliverySnapshotOf, openConnectorDelivery, sealConnectorDelivery, type DeliveryContext, type DeliverySnapshot } from '../src/connector-delivery.js';

const pair = generateKeyPairSync('x25519');
const key = rawPublicKey(pair.publicKey);
const opaque = (): string => randomBytes(32).toString('base64url');
const context: DeliveryContext = { owner: 'org_01TESTOWNER000000', agent: 'agent000001', keyId: opaque(), requestId: opaque() };
const now = Date.now();
const snapshot: DeliverySnapshot = {
  version: 1, issuedAt: now, expiresAt: now + CONNECTOR_DELIVERY_LEASE_MS,
  connectors: [{ id: 'conn0000001', name: 'Calendar', url: 'https://vendor.example/private?key=URL_SECRET', auth: 'oauth', headers: { Authorization: 'Bearer ACCESS_SECRET' }, policy: { read: 'allow', write: 'deny' }, revision: opaque(), state: 'ready', expiresAt: now + 3600_000 }],
};

function changed(text: string): string {
  const bytes = Buffer.from(text, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString('base64url');
}

describe('sealed connector delivery', () => {
  test('round trips only the intended snapshot, uses fresh keys and hides URLs and headers', () => {
    const sealed = sealConnectorDelivery(key, context, snapshot);
    expect(openConnectorDelivery(pair.privateKey, context, sealed)).toEqual(snapshot);
    expect(JSON.stringify(sealed)).not.toContain('URL_SECRET');
    expect(JSON.stringify(sealed)).not.toContain('ACCESS_SECRET');
    expect(Buffer.from(sealed.ciphertext, 'base64url').toString('utf8')).not.toContain('ACCESS_SECRET');
    expect(sealConnectorDelivery(key, context, snapshot).ephemeralKey).not.toBe(sealed.ephemeralKey);
    expect(Buffer.byteLength(JSON.stringify({ sealed }))).toBeLessThan(CONNECTOR_DELIVERY_MAX_BYTES);
  });

  test('every context field is authenticated, even with the same private key', () => {
    const sealed = sealConnectorDelivery(key, context, snapshot);
    for (const altered of [{ owner: 'org_01TESTOTHER000000' }, { agent: 'agent000002' }, { keyId: opaque() }, { requestId: opaque() }]) {
      expect(() => openConnectorDelivery(pair.privateKey, { ...context, ...altered }, sealed)).toThrow();
    }
    expect(() => openConnectorDelivery(generateKeyPairSync('x25519').privateKey, context, sealed)).toThrow();
    expect(() => openConnectorDelivery(generateKeyPairSync('ed25519').privateKey, context, sealed)).toThrow();
    expect(() => openConnectorDelivery(pair.publicKey, context, sealed)).toThrow();
  });

  test('tampering with any envelope component or adding fields fails', () => {
    const sealed = sealConnectorDelivery(key, context, snapshot);
    for (const field of ['ephemeralKey', 'iv', 'tag', 'ciphertext'] as const) {
      expect(() => openConnectorDelivery(pair.privateKey, context, { ...sealed, [field]: changed(sealed[field]) })).toThrow();
      expect(() => openConnectorDelivery(pair.privateKey, context, { ...sealed, [field]: `${sealed[field]}=` })).toThrow();
    }
    for (const invalid of [null, [], {}, { ...sealed, version: 2 }, { ...sealed, unknown: 1 }, { ...sealed, tag: opaque() }, { ...sealed, ephemeralKey: 'A'.repeat(43) }]) {
      expect(() => openConnectorDelivery(pair.privateKey, context, invalid)).toThrow();
    }
    expect(() => sealConnectorDelivery('A'.repeat(43), context, snapshot)).toThrow();
    expect(() => sealConnectorDelivery(key, { ...context, requestId: 'a'.repeat(43) }, snapshot)).toThrow();
  });

  test('oversized snapshots fail rather than dropping assignments', () => {
    const first = snapshot.connectors[0];
    if (first === undefined) throw new Error('missing fixture');
    const many = Array.from({ length: 100 }, (_, index) => ({ ...first, id: `conn${String(index).padStart(7, '0')}`, headers: { Authorization: `Bearer ${'A'.repeat(16_000)}` } }));
    expect(() => sealConnectorDelivery(key, context, { ...snapshot, connectors: many })).toThrow('too large');
    const sealed = sealConnectorDelivery(key, context, snapshot);
    expect(() => openConnectorDelivery(pair.privateKey, context, { ...sealed, ciphertext: 'a'.repeat(CONNECTOR_DELIVERY_MAX_BYTES) })).toThrow('too large');
  });
});

describe('delivery payload validation', () => {
  test('only exact bounded snapshots with unique connectors are accepted', () => {
    for (const patch of [{ version: 2 }, { extra: true }, { issuedAt: NaN }, { issuedAt: 1.5 }, { expiresAt: now }, { expiresAt: now + CONNECTOR_DELIVERY_LEASE_MS + 1 }, { connectors: {} }, { connectors: [...snapshot.connectors, ...snapshot.connectors] }]) {
      expect(() => deliverySnapshotOf({ ...snapshot, ...patch })).toThrow();
    }
    expect(deliverySnapshotOf({ ...snapshot, connectors: [] }).connectors).toEqual([]);
  });

  test('negotiated policy layers are strict and older snapshots remain readable', () => {
    expect(deliverySnapshotOf(snapshot)).toEqual(snapshot);
    const connector = snapshot.connectors[0];
    const policyLayers = { organization: { write: 'deny', tools: { find: 'allow' } }, agent: { read: 'ask' } };
    const layered = { ...snapshot, connectors: [{ ...connector, policyLayers }] };
    expect(deliverySnapshotOf(layered).connectors[0]?.policyLayers).toEqual(policyLayers);
    for (const invalid of [null, {}, { ...policyLayers, extra: {} }, { organization: { read: 'unknown' }, agent: {} }, { organization: {}, agent: { tools: { constructor: 'allow' } } }]) {
      expect(() => deliverySnapshotOf({ ...snapshot, connectors: [{ ...connector, policyLayers: invalid }] })).toThrow();
    }
  });

  test('no credential material outside a sendable ready header is accepted', () => {
    const connector = snapshot.connectors[0];
    for (const patch of [{ refreshToken: 'SECRET' }, { clientSecret: 'SECRET' }, { secret: 'CIPHERTEXT' }, { policy: { read: 'surprise' } }, { revision: 'not-a-revision' }, { headers: { Authorization: 'Bearer BAD\r\nInjected: 1' } }, { headers: { 'X-Token': 'ACCESS_SECRET' } }, { state: 'signin' }, { state: 'unavailable' }, { expiresAt: now }, { expiresAt: -1 }, { url: 'http://vendor.example/' }, { url: 'https://user:pass@vendor.example/' }]) {
      expect(() => deliverySnapshotOf({ ...snapshot, connectors: [{ ...connector, ...patch }] })).toThrow();
    }
  });
});

describe('strict connector policy intersection', () => {
  test('group decisions cannot be weakened and named overrides cannot bypass an assignment', () => {
    expect(combineConnectorPolicies({}, {})).toEqual({});
    expect(combineConnectorPolicies({ read: 'deny', write: 'ask' }, { read: 'allow', write: 'allow' })).toEqual({ read: 'deny', write: 'ask' });
    expect(combineConnectorPolicies({ tools: { send: 'allow', list: 'ask' } }, { write: 'deny' })).toEqual({ read: 'allow', write: 'deny', tools: { send: 'deny', list: 'deny' } });
    expect(combineConnectorPolicies({ tools: { send: 'deny' } }, { tools: { send: 'allow', list: 'ask' } })).toEqual({ read: 'allow', write: 'allow', tools: { send: 'deny', list: 'ask' } });
  });

  test('unknown policy values and unsafe tool dictionaries are never treated as allow', () => {
    for (const invalid of [null, [], { foo: 'allow' }, { write: 'unknown' }, { tools: null }, { tools: { send: true } }, JSON.parse('{"tools":{"__proto__":"allow"}}') as unknown]) {
      expect(() => connectorPolicyOf(invalid)).toThrow();
    }
  });
});
