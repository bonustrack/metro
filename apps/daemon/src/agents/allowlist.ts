import { ApiError } from '@metro-labs/http/api-error';
import { normalizeSenderList, senderEntry } from '@metro-labs/http/sender-list';

export const normalizeAllowlist = normalizeSenderList;

export function normalizeApprovers(raw: unknown, allowlist: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ApiError('approvers must be a list of sender ids', 400);
  const listed = new Set(allowlist.map((entry) => entry.toLowerCase()));
  const seen = new Set<string>();
  return raw.map(senderEntry).filter((value) => {
    const key = value.toLowerCase();
    if (!listed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
