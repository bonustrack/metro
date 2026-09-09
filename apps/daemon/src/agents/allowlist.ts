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

function senderId(entry: unknown): string {
  if (typeof entry !== 'string') throw new ApiError('allowlist must be a list of sender ids', 400);
  const value = entry.trim();
  if (value.length > MAX_LENGTH || hasControlChar(value))
    throw new ApiError(`a sender id is at most ${String(MAX_LENGTH)} plain characters`, 400);
  return value;
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
