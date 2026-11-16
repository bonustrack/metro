import { builtInDaemon } from '../auth/daemon.js';
import { isRecord } from '../read.js';
import { PROVIDERS, type Provider } from './auth.js';

export interface SignInOptions {
  providers: Provider[];
}

export const DEFAULT_SIGN_IN: SignInOptions = { providers: PROVIDERS };

const isProvider = (value: unknown): value is Provider => (PROVIDERS as unknown[]).includes(value);

export function toSignInOptions(body: unknown): SignInOptions {
  const listed = isRecord(body) && Array.isArray(body.providers) ? body.providers.filter(isProvider) : [];
  return { providers: [...new Set(listed)] };
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
