import { ApiError } from '@metro-labs/http/api-error';

export interface UserLogin {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  createdAt: string | null;
}

export type UserStatus = 'approved' | 'waitlist' | 'rejected';
export const isUserStatus = (v: unknown): v is UserStatus => v === 'approved' || v === 'waitlist' || v === 'rejected';

export interface UserRecord extends UserLogin {
  avatar: string | null;
  lastLoginAt: string | null;
  status: UserStatus | null;
}

export interface UserStore {
  avatar: (user: string) => Promise<string | null>;
  avatars: (users: string[]) => Promise<Map<string, string>>;
  setAvatar: (user: string, avatar: string | null) => Promise<void>;
  noteLogin: (user: UserLogin, at: string) => Promise<void>;
  find: (user: string) => Promise<UserRecord | null>;
  list: () => Promise<UserRecord[]>;
  setStatus: (user: string, status: UserStatus) => Promise<void>;
}

const NAME_MAX = 80;

export function parseAccountName(raw: unknown): { first: string; last: string | null } {
  const name = typeof raw === 'string' ? raw.replace(/[\p{Cc}]/gu, '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) : '';
  if (name === '') throw new ApiError('the name cannot be empty', 400);
  const cut = name.indexOf(' ');
  return cut === -1 ? { first: name, last: null } : { first: name.slice(0, cut), last: name.slice(cut + 1) };
}
