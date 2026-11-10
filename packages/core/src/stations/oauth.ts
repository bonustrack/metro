import { createHash, randomBytes } from 'node:crypto';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkcePair(verifier = randomBytes(32).toString('base64url')): Pkce {
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
