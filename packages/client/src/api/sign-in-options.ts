import { builtInDaemon } from '../auth/daemon.js';
import { isRecord } from '../read.js';
import { PROVIDERS, type Provider } from './auth.js';

export type Accounts = 'workos' | 'metro';

export interface SignInOptions {
  accounts: Accounts;
  providers: Provider[];
  emailCode: boolean;
}

export const WORKOS_SIGN_IN: SignInOptions = { accounts: 'workos', providers: PROVIDERS, emailCode: true };

const isMetroProvider = (value: unknown): value is Provider => value === 'google' || value === 'microsoft';

export function toSignInOptions(body: unknown): SignInOptions {
  if (!isRecord(body) || body.accounts !== 'metro') return WORKOS_SIGN_IN;
  const listed = Array.isArray(body.providers) ? body.providers.filter(isMetroProvider) : [];
  return { accounts: 'metro', providers: [...new Set(listed)], emailCode: false };
}

export async function fetchSignInOptions(): Promise<SignInOptions> {
  let res: Response;
  try {
    res = await fetch(`${builtInDaemon()}/api/mode`);
  } catch {
    throw new Error('Failed to reach Metro.');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body)) throw new Error(`Metro returned ${String(res.status)}.`);
  return toSignInOptions(body);
}
