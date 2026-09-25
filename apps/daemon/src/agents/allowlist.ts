import { ApiError } from '@metro-labs/http/api-error';

export const EVERYONE = '*';
const MAX_ENTRIES = 500;
const MAX_LENGTH = 200;

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const DOMAIN_ENTRY_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function domainEntry(value: string): string {
  const domain = value.toLowerCase();
  if (!DOMAIN_ENTRY_RE.test(domain))
    throw new ApiError(`'${value}' is not a domain; write it as @example.com`, 400);
  return domain;
}

function senderId(entry: unknown): string {
  if (typeof entry !== 'string') throw new ApiError('allowlist must be a list of sender ids', 400);
  const value = entry.trim();
  if (value.length > MAX_LENGTH || hasControlChar(value))
    throw new ApiError(`a sender id is at most ${String(MAX_LENGTH)} plain characters`, 400);
  return value.startsWith('@') ? domainEntry(value) : value;
}

export function normalizeApprovers(raw: unknown, allowlist: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ApiError('approvers must be a list of sender ids', 400);
  const listed = new Set(allowlist.map((entry) => entry.toLowerCase()));
  const seen = new Set<string>();
  return raw.map(senderId).filter((value) => {
    const key = value.toLowerCase();
    if (!listed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ApiError('allowlist must be a list of sender ids', 400);
  if (raw.length > MAX_ENTRIES) throw new ApiError(`allowlist holds at most ${String(MAX_ENTRIES)} senders`, 400);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const value = senderId(entry);
    if (value === EVERYONE) return [EVERYONE];
    const key = value.toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length === 0 ? [EVERYONE] : out;
}
