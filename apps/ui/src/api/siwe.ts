import { createSiweMessage } from 'viem/siwe';
import { isRecord } from './accounts';
import { daemonBase } from '../auth/session';

const EXPIRES_MS = 10 * 60_000;
const STATEMENT = 'Sign in to Metro.';

async function siwe(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${daemonBase()}${path}`, init);
  } catch {
    throw new Error('Failed to reach Metro.');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `Metro returned ${String(res.status)}.`,
    );
  return body;
}

export async function fetchNonce(): Promise<string> {
  const body = await siwe('/auth/siwe/nonce');
  if (!isRecord(body) || typeof body.nonce !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return body.nonce;
}

export function loginMessage(
  address: `0x${string}`,
  nonce: string,
  now = new Date(),
): string {
  return createSiweMessage({
    address,
    chainId: 1,
    domain: window.location.host,
    nonce,
    uri: window.location.origin,
    version: '1',
    statement: STATEMENT,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + EXPIRES_MS),
  });
}

export async function verifyLogin(
  message: string,
  signature: string,
): Promise<string> {
  const body = await siwe('/auth/siwe/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  if (!isRecord(body) || typeof body.session !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return body.session;
}
