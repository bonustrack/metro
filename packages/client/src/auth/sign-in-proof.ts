import { sha256 } from '@noble/hashes/sha2';
import { randomBytes, readTabItem, writeTabItem } from '../platform.js';

const VERIFIER_KEY = 'metro.signin.verifier';

function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const challengeOf = (verifier: string): string => base64url(sha256(new TextEncoder().encode(verifier)));

export function startWebProof(): string {
  const verifier = base64url(randomBytes(32));
  writeTabItem(VERIFIER_KEY, verifier);
  return challengeOf(verifier);
}

export function takeWebVerifier(): string | undefined {
  const verifier = readTabItem(VERIFIER_KEY);
  writeTabItem(VERIFIER_KEY, null);
  return verifier ?? undefined;
}
