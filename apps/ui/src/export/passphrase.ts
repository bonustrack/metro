import { buffer, fromBase64Url, toBase64Url } from './bytes.js';

const PASSPHRASE_MIN = 8;
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;

export interface PassphraseEnvelope {
  v: 2;
  agentId: string;
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

async function keyFor(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', buffer(utf8(passphrase.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function checkPassphrase(passphrase: string): string | null {
  if (passphrase.length < PASSPHRASE_MIN) return `Use at least ${String(PASSPHRASE_MIN)} characters.`;
  return null;
}

export async function sealWithPassphrase(plain: Uint8Array, passphrase: string, agentId: string): Promise<PassphraseEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await keyFor(passphrase, salt, ITERATIONS);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(utf8(agentId)) }, key, buffer(plain)));
  return { v: 2, agentId, iterations: ITERATIONS, salt: toBase64Url(salt), nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
}

export async function openWithPassphrase(envelope: PassphraseEnvelope, passphrase: string): Promise<Uint8Array> {
  const key = await keyFor(passphrase, fromBase64Url(envelope.salt), envelope.iterations);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(fromBase64Url(envelope.nonce)), additionalData: buffer(utf8(envelope.agentId)) }, key, buffer(fromBase64Url(envelope.ciphertext))),
    );
  } catch {
    throw new Error('That passphrase does not open this file.');
  }
}

export const isPassphraseEnvelope = (value: unknown): value is PassphraseEnvelope =>
  typeof value === 'object' && value !== null && (value as { v?: unknown }).v === 2 && typeof (value as { salt?: unknown }).salt === 'string';
