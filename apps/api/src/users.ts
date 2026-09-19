import { ApiError } from '@metro-labs/http/api-error';

export interface UserStore {
  avatar: (user: string) => Promise<string | null>;
  avatars: (users: string[]) => Promise<Map<string, string>>;
  setAvatar: (user: string, avatar: string | null) => Promise<void>;
}

const NAME_MAX = 80;

export function parseAccountName(raw: unknown): { first: string; last: string | null } {
  const name = typeof raw === 'string' ? raw.replace(/[\p{Cc}]/gu, '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) : '';
  if (name === '') throw new ApiError('the name cannot be empty', 400);
  const cut = name.indexOf(' ');
  return cut === -1 ? { first: name, last: null } : { first: name.slice(0, cut), last: name.slice(cut + 1) };
}
