import { hkdfSync } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { mapHashToField } from '@noble/curves/abstract/modular';
import { privateKeyToAccount } from 'viem/accounts';

export const ENCRYPTION_KEY_TYPED_DATA = {
  domain: { name: 'metro', version: '1' },
  types: {
    EncryptionKey: [
      { name: 'purpose', type: 'string' },
      { name: 'keyVersion', type: 'uint256' },
    ],
  },
  primaryType: 'EncryptionKey',
  message: { purpose: 'encryption-key', keyVersion: 1n },
} as const;

const KEY_SALT = 'metro';
const IDENTITY_INFO = 'vault-secp256k1';
const KEY_HASH_BYTES = 48;

const toHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

export function deriveIdentityKey(signature: `0x${string}`): `0x${string}` {
  const ikm = Buffer.from(signature.slice(2), 'hex');
  const hash = new Uint8Array(hkdfSync('sha256', ikm, KEY_SALT, IDENTITY_INFO, KEY_HASH_BYTES));
  return toHex(mapHashToField(hash, secp256k1.CURVE.n));
}

export function deriveIdentityAddress(signature: `0x${string}`): string {
  return privateKeyToAccount(deriveIdentityKey(signature)).address.toLowerCase();
}
