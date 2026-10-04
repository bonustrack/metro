import { strToU8 } from 'fflate';
import { fromBase64Url, toBase64Url } from './bytes.js';
import { openBytes, sealBytes } from './primitives.js';
import { randomBytes } from '../platform.js';

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

const utf8 = (s: string): Uint8Array => strToU8(s);

export function checkPassphrase(passphrase: string): string | null {
  if (passphrase.length < PASSPHRASE_MIN) return `Use at least ${String(PASSPHRASE_MIN)} characters.`;
  return null;
}

export async function sealWithPassphrase(plain: Uint8Array, passphrase: string, agentId: string): Promise<PassphraseEnvelope> {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = await sealBytes({ passphrase, salt, iterations: ITERATIONS, nonce, aad: utf8(agentId) }, plain);
  return { v: 2, agentId, iterations: ITERATIONS, salt: toBase64Url(salt), nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
}

export async function openWithPassphrase(envelope: PassphraseEnvelope, passphrase: string): Promise<Uint8Array> {
  const sealing = { passphrase, salt: fromBase64Url(envelope.salt), iterations: envelope.iterations, nonce: fromBase64Url(envelope.nonce), aad: utf8(envelope.agentId) };
  try {
    return await openBytes(sealing, fromBase64Url(envelope.ciphertext));
  } catch {
    throw new Error('That passphrase does not open this file.');
  }
}

export const isPassphraseEnvelope = (value: unknown): value is PassphraseEnvelope =>
  typeof value === 'object' && value !== null && (value as { v?: unknown }).v === 2 && typeof (value as { salt?: unknown }).salt === 'string';
