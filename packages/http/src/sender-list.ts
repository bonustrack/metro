import { ApiError } from './api-error.js';

export const ANYONE = '*';
const MAX_ENTRIES = 500;
const MAX_LENGTH = 200;
const DOMAIN_ENTRY_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const EMAIL_RE = /^[^@\s/]+@([^@\s/]+)$/;

export type SenderVerdict = 'allow' | 'not_listed' | 'not_verified';

export interface ListedSender {
  id: string | null;
  verified?: boolean;
}

function entryOf(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError('The people who can write must be a list of sender ids.', 400);
  const value = raw.trim();
  if (value.length > MAX_LENGTH || /\p{Cc}/u.test(value)) throw new ApiError(`A sender id is at most ${String(MAX_LENGTH)} plain characters.`, 400);
  if (!value.startsWith('@')) return value;
  const domain = value.toLowerCase();
  if (!DOMAIN_ENTRY_RE.test(domain)) throw new ApiError(`'${value}' is not a domain; write it as @example.com`, 400);
  return domain;
}

export function normalizeSenderList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ApiError('The people who can write must be a list of sender ids.', 400);
  if (raw.length > MAX_ENTRIES) throw new ApiError(`The list holds at most ${String(MAX_ENTRIES)} senders.`, 400);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const value = entryOf(entry);
    if (value === ANYONE) return [ANYONE];
    const key = value.toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length === 0 ? [ANYONE] : out;
}

export function senderListOf(text: string | null): string[] {
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];
    return list.length === 0 || list.includes(ANYONE) ? [ANYONE] : list;
  } catch {
    return [ANYONE];
  }
}

export const anyoneListed = (list: string[]): boolean => list.length === 0 || list.includes(ANYONE);

export function senderListed(list: string[], id: string): boolean {
  if (anyoneListed(list)) return true;
  const sender = id.trim().toLowerCase();
  return list.some((entry) => {
    const wanted = entry.toLowerCase();
    return wanted === sender || (wanted.startsWith('@') && wanted.length > 1 && EMAIL_RE.exec(sender)?.[1] === wanted.slice(1));
  });
}

export function senderVerdict(list: string[], sender: ListedSender | null): SenderVerdict {
  if (anyoneListed(list)) return 'allow';
  if (sender === null || sender.id === null || !senderListed(list, sender.id)) return 'not_listed';
  return sender.verified === false ? 'not_verified' : 'allow';
}
