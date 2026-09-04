import { walletKeys, type WalletKeys } from '../vault/crypto';

const STORAGE_KEY = 'metro.identity';

export interface Identity extends WalletKeys {
  signature: `0x${string}`;
}

interface Stored {
  address: string;
  signature: `0x${string}`;
}

let active: Identity | null = null;

export function activeIdentity(): Identity | null {
  return active;
}

export async function identityFrom(address: string, signature: `0x${string}`): Promise<Identity> {
  return { ...(await walletKeys(address, signature)), signature };
}

function readStored(): Stored | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { address, signature } = parsed as { address?: unknown; signature?: unknown };
    if (typeof address !== 'string' || typeof signature !== 'string' || !signature.startsWith('0x')) return null;
    return { address, signature: signature as `0x${string}` };
  } catch {
    return null;
  }
}

export async function loadIdentity(): Promise<Identity | null> {
  const stored = readStored();
  active = stored === null ? null : await identityFrom(stored.address, stored.signature);
  return active;
}

export function storeIdentity(identity: Identity): void {
  active = identity;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ address: identity.address, signature: identity.signature }),
    );
  } catch {
    return;
  }
}

export function clearIdentity(): void {
  active = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
}
