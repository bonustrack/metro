import { ApiError } from './api-error.js';

export const ANYONE = '*';
export const SENDERS_MAX = 500;
const ENTRY_MAX = 320;

const DOMAIN_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ADDRESS_RE = /^[^@\s/<>"]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/;

export type SenderVerdict = 'ok' | 'sender' | 'unverified';

function entryOf(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError('People must be a list of email addresses or domains.', 400);
  const value = raw.trim().toLowerCase();
  if (value === ANYONE) return ANYONE;
  if (value.length > ENTRY_MAX || !(DOMAIN_RE.test(value) || ADDRESS_RE.test(value)))
    throw new ApiError(`'${raw.trim().slice(0, 64)}' is not an email address or a domain. Write it as name@example.com or @example.com.`, 400);
  return value;
}

export function normalizeMailSenders(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ApiError('People must be a list of email addresses or domains.', 400);
  if (raw.length > SENDERS_MAX) throw new ApiError(`People holds at most ${String(SENDERS_MAX)} entries.`, 400);
  const entries = [...new Set(raw.map(entryOf))];
  return entries.length === 0 || entries.includes(ANYONE) ? [ANYONE] : entries;
}

export function sendersOf(text: string | null): string[] {
  if (text === null) return [ANYONE];
  try {
    return normalizeMailSenders(JSON.parse(text));
  } catch {
    return [];
  }
}

function matches(entry: string, address: string): boolean {
  if (entry === address) return true;
  return entry.startsWith('@') && ADDRESS_RE.exec(address)?.[1] === entry.slice(1);
}

export function mailSenderVerdict(senders: string[], address: string, verified: boolean): SenderVerdict {
  if (senders.includes(ANYONE)) return 'ok';
  const from = address.trim().toLowerCase();
  if (!senders.some((entry) => matches(entry, from))) return 'sender';
  return verified ? 'ok' : 'unverified';
}
