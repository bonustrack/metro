import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { rawPublicKey, sealingKeyOf } from './agent-signature.js';
import { deliveryBytes, deliveryRecord } from './connector-delivery-validation.js';

export interface SealedTransfer {
  version: 1;
  ephemeralKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function cipherKey(privateKey: KeyObject, publicKey: KeyObject, context: Buffer, ephemeral: string, recipient: string): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  if (!shared.some((byte) => byte !== 0)) throw new Error('Invalid connector transfer key.');
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([deliveryBytes(ephemeral, 32), deliveryBytes(recipient, 32)]), context, 32));
}

export function sealTransfer(publicKey: string, aad: Buffer, bytes: Buffer): SealedTransfer {
  const recipient = sealingKeyOf(publicKey);
  if (recipient === null) throw new Error('Invalid connector transfer key.');
  const pair = generateKeyPairSync('x25519');
  const ephemeralKey = rawPublicKey(pair.publicKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(pair.privateKey, recipient, aad, ephemeralKey, publicKey), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64url');
  return { version: 1, ephemeralKey, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext };
}

export function openTransfer(privateKey: KeyObject, aad: Buffer, envelope: unknown, maxBytes: number): Buffer {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519') throw new Error('Invalid connector transfer key.');
  const value = deliveryRecord(envelope, ['version', 'ephemeralKey', 'iv', 'tag', 'ciphertext']);
  if (value.version !== 1 || typeof value.ephemeralKey !== 'string') throw new Error('Invalid connector transfer envelope.');
  const ephemeral = sealingKeyOf(value.ephemeralKey);
  if (ephemeral === null) throw new Error('Invalid connector transfer key.');
  const ciphertext = deliveryBytes(value.ciphertext);
  if (ciphertext.length > maxBytes) throw new Error('Connector transfer is too large.');
  const key = cipherKey(privateKey, ephemeral, aad, value.ephemeralKey, rawPublicKey(createPublicKey(privateKey)));
  const decipher = createDecipheriv('aes-256-gcm', key, deliveryBytes(value.iv, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(deliveryBytes(value.tag, 16));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
