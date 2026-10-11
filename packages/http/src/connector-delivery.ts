import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { rawPublicKey, sealingKeyOf } from './agent-signature.js';
import { CONNECTOR_DELIVERY_MAX_BYTES, DELIVERY_PLAINTEXT_MAX, deliveryBytes, deliveryContextBytes, deliveryRecord, deliverySnapshotOf, type DeliveryContext, type DeliverySnapshot } from './connector-delivery-validation.js';

export { CONNECTOR_DELIVERY_LEASE_MS, CONNECTOR_DELIVERY_MAX_BYTES, deliverySnapshotOf, type DeliveryContext, type DeliverySnapshot, type DeliveredConnector } from './connector-delivery-validation.js';
export { combineConnectorPolicies, connectorPolicyOf, type ConnectorPolicy } from './connector-policy.js';

export interface SealedDelivery {
  version: 1;
  ephemeralKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function cipherKey(privateKey: KeyObject, publicKey: KeyObject, context: Buffer, ephemeral: string, recipient: string): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  if (!shared.some((byte) => byte !== 0)) throw new Error('Invalid connector delivery key.');
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([deliveryBytes(ephemeral, 32), deliveryBytes(recipient, 32)]), context, 32));
}

export function sealConnectorDelivery(publicKey: string, context: DeliveryContext, snapshot: DeliverySnapshot): SealedDelivery {
  const aad = deliveryContextBytes(context);
  const recipient = sealingKeyOf(publicKey);
  if (recipient === null) throw new Error('Invalid connector delivery key.');
  const bytes = Buffer.from(JSON.stringify(deliverySnapshotOf(snapshot)));
  const pair = generateKeyPairSync('x25519');
  const ephemeralKey = rawPublicKey(pair.publicKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(pair.privateKey, recipient, aad, ephemeralKey, publicKey), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64url');
  const sealed: SealedDelivery = { version: 1, ephemeralKey, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext };
  if (Buffer.byteLength(JSON.stringify({ sealed })) > CONNECTOR_DELIVERY_MAX_BYTES) throw new Error('Connector delivery is too large.');
  return sealed;
}

export function openConnectorDelivery(privateKey: KeyObject, context: DeliveryContext, envelope: unknown): DeliverySnapshot {
  const aad = deliveryContextBytes(context);
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519') throw new Error('Invalid connector delivery key.');
  if (Buffer.byteLength(JSON.stringify({ sealed: envelope })) > CONNECTOR_DELIVERY_MAX_BYTES) throw new Error('Connector delivery is too large.');
  const value = deliveryRecord(envelope, ['version', 'ephemeralKey', 'iv', 'tag', 'ciphertext']);
  if (value.version !== 1 || typeof value.ephemeralKey !== 'string') throw new Error('Invalid connector delivery envelope.');
  const ephemeral = sealingKeyOf(value.ephemeralKey);
  if (ephemeral === null) throw new Error('Invalid connector delivery key.');
  const ciphertext = deliveryBytes(value.ciphertext);
  if (ciphertext.length > DELIVERY_PLAINTEXT_MAX) throw new Error('Connector delivery is too large.');
  const key = cipherKey(privateKey, ephemeral, aad, value.ephemeralKey, rawPublicKey(createPublicKey(privateKey)));
  const decipher = createDecipheriv('aes-256-gcm', key, deliveryBytes(value.iv, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(deliveryBytes(value.tag, 16));
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return deliverySnapshotOf(JSON.parse(plaintext.toString('utf8')) as unknown);
}
