import { secp256k1 } from '@noble/curves/secp256k1';
import { mapHashToField } from '@noble/curves/abstract/modular';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

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

export const KEY_VERSION = 1;

export interface WalletKeys {
  address: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  vault: PrivateKeyAccount;
}

export interface WrappedKey {
  recipient: string;
  recipientPublicKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
}

export interface Envelope {
  v: 1;
  keyVersion: number;
  agentId: string;
  nonce: string;
  ciphertext: string;
  key: WrappedKey;
}

const KEY_SALT = 'metro';
const KEY_INFO = 'secp256k1';
const VAULT_INFO = 'vault-secp256k1';
const KEY_HASH_BYTES = 48;
const WRAP_SALT = 'metro-wrap';
const NONCE_BYTES = 12;
const DEK_BYTES = 32;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error('not a hex signature');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

async function hkdf(ikm: Uint8Array, salt: string, info: Uint8Array, bytes = 32): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', buffer(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buffer(utf8(salt)), info: buffer(info) },
    material,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

const aesKey = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

const toScalar = (hash: Uint8Array): Uint8Array => mapHashToField(hash, secp256k1.CURVE.n);

const sharedSecret = (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array =>
  secp256k1.getSharedSecret(privateKey, publicKey, true).slice(1);

async function encrypt(rawKey: Uint8Array, plaintext: Uint8Array, aad: string): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(utf8(aad)) },
    await aesKey(rawKey),
    buffer(plaintext),
  );
  return { nonce, ciphertext: new Uint8Array(ciphertext) };
}

async function decrypt(rawKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: string): Promise<Uint8Array> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(utf8(aad)) },
      await aesKey(rawKey),
      buffer(ciphertext),
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error('the bundle could not be opened: it was sealed for another key or has been altered');
  }
}

const toHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

export async function walletKeys(address: string, signature: string): Promise<WalletKeys> {
  const ikm = hexToBytes(signature);
  const privateKey = toScalar(await hkdf(ikm, KEY_SALT, utf8(KEY_INFO), KEY_HASH_BYTES));
  const vaultKey = toScalar(await hkdf(ikm, KEY_SALT, utf8(VAULT_INFO), KEY_HASH_BYTES));
  return {
    address: address.toLowerCase(),
    privateKey,
    publicKey: secp256k1.getPublicKey(privateKey, true),
    vault: privateKeyToAccount(toHex(vaultKey)),
  };
}

export const requestChallenge = (method: string, path: string, at: number): string =>
  `metro-auth\n${method} ${path}\n${String(at)}`;

export async function signRequest(keys: WalletKeys, method: string, path: string, at = Date.now()): Promise<string> {
  const signature = await keys.vault.signMessage({ message: requestChallenge(method, path, at) });
  return `Metro ${keys.vault.address} ${String(at)} ${signature}`;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function wrapKey(dek: Uint8Array, recipient: Pick<WalletKeys, 'address' | 'publicKey'>): Promise<WrappedKey> {
  const ephemeral = secp256k1.utils.randomPrivateKey();
  const ephemeralPublicKey = secp256k1.getPublicKey(ephemeral, true);
  const shared = sharedSecret(ephemeral, recipient.publicKey);
  const wrapping = await hkdf(shared, WRAP_SALT, concat(ephemeralPublicKey, recipient.publicKey));
  const { nonce, ciphertext } = await encrypt(wrapping, dek, recipient.address);
  return {
    recipient: recipient.address,
    recipientPublicKey: toBase64Url(recipient.publicKey),
    ephemeralPublicKey: toBase64Url(ephemeralPublicKey),
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
  };
}

async function unwrapKey(wrapped: WrappedKey, wallet: WalletKeys): Promise<Uint8Array> {
  if (wrapped.recipient !== wallet.address)
    throw new Error(`this bundle was sealed for ${wrapped.recipient}, not for the wallet you signed with`);
  const ephemeralPublicKey = fromBase64Url(wrapped.ephemeralPublicKey);
  const shared = sharedSecret(wallet.privateKey, ephemeralPublicKey);
  const wrapping = await hkdf(shared, WRAP_SALT, concat(ephemeralPublicKey, wallet.publicKey));
  return decrypt(wrapping, fromBase64Url(wrapped.nonce), fromBase64Url(wrapped.ciphertext), wallet.address);
}

export async function sealBundle(
  plaintext: string,
  agentId: string,
  recipient: Pick<WalletKeys, 'address' | 'publicKey'>,
): Promise<Envelope> {
  const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  const { nonce, ciphertext } = await encrypt(dek, utf8(plaintext), agentId);
  return {
    v: 1,
    keyVersion: KEY_VERSION,
    agentId,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
    key: await wrapKey(dek, recipient),
  };
}

export async function openBundle(envelope: Envelope, wallet: WalletKeys): Promise<string> {
  const dek = await unwrapKey(envelope.key, wallet);
  const plain = await decrypt(dek, fromBase64Url(envelope.nonce), fromBase64Url(envelope.ciphertext), envelope.agentId);
  return new TextDecoder().decode(plain);
}
