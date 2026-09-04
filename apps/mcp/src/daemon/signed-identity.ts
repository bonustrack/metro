import type { IncomingMessage } from 'node:http';
import { verifyMessage } from 'viem';
import { normalizeAddress } from '../db/address.js';

export const AUTH_SCHEME = 'Metro';
const SKEW_MS = 5 * 60_000;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export const identityChallenge = (method: string, path: string, at: number): string =>
  `metro-auth\n${method} ${path}\n${String(at)}`;

export interface SignedHeader {
  address: string;
  at: number;
  signature: `0x${string}`;
}

export function parseIdentityHeader(header: string): SignedHeader | null {
  const [scheme, rawAddress, rawAt, signature] = header.trim().split(/\s+/);
  if (scheme !== AUTH_SCHEME || rawAddress === undefined || rawAt === undefined || signature === undefined) return null;
  const address = normalizeAddress(rawAddress);
  const at = Number(rawAt);
  if (address === null || !Number.isFinite(at) || !SIGNATURE_RE.test(signature)) return null;
  return { address, at, signature: signature as `0x${string}` };
}

export async function signedIdentity(req: IncomingMessage, now = Date.now()): Promise<string | null> {
  const proof = parseIdentityHeader(req.headers.authorization ?? '');
  if (proof === null || Math.abs(now - proof.at) > SKEW_MS) return null;
  const path = (req.url ?? '').split('?')[0] ?? '';
  const message = identityChallenge(req.method ?? '', path, proof.at);
  const ok = await verifyMessage({ address: proof.address as `0x${string}`, message, signature: proof.signature }).catch(
    () => false,
  );
  return ok ? proof.address : null;
}
