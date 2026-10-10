import { createHash, randomBytes } from 'node:crypto';
import { dataKeyAad, openWith, sealWith, SealError } from './envelope.js';
import { decryptDataKey, generateDataKey, type KmsContext, type KmsKey } from './kms.js';

const DATA_KEY_BYTES = 32;

export interface WrappedKey {
  key: Buffer;
  wrapped: string;
}

export interface KeyWrapper {
  readonly id: string;
  create: (owner: string) => Promise<WrappedKey>;
  unwrap: (owner: string, wrapped: string) => Promise<Buffer>;
}

const kmsContext = (owner: string): KmsContext => ({ 'metro:organization': owner, 'metro:purpose': 'connectors' });

export function kmsWrapper(key: KmsKey): KeyWrapper {
  return {
    id: `kms:${key.arn}`,
    create: async (owner) => {
      const made = await generateDataKey(key, kmsContext(owner));
      return { key: made.plain, wrapped: made.wrapped };
    },
    unwrap: (owner, wrapped) => decryptDataKey(key, wrapped, kmsContext(owner)),
  };
}

export function localWrapper(secret: Buffer): KeyWrapper {
  if (secret.length !== DATA_KEY_BYTES) throw new SealError('the local connector key must be 32 bytes', 500);
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  return {
    id: `local:${fingerprint}`,
    create: (owner) => {
      const key = randomBytes(DATA_KEY_BYTES);
      return Promise.resolve({ key, wrapped: sealWith(secret, dataKeyAad(owner), key) });
    },
    unwrap: (owner, wrapped) => {
      const key = openWith(secret, dataKeyAad(owner), wrapped);
      if (key.length !== DATA_KEY_BYTES) return Promise.reject(new SealError('a stored connector key has the wrong size', 500));
      return Promise.resolve(key);
    },
  };
}
