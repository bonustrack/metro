import type { UserRecord, UserStore } from '../src/users.ts';

export function memoryUsers(): UserStore & { records: Map<string, UserRecord> } {
  const records = new Map<string, UserRecord>();
  const blank = (id: string): UserRecord => ({ id, email: null, name: null, picture: null, avatar: null, createdAt: null, lastLoginAt: null });
  return {
    records,
    avatar: (user) => Promise.resolve(records.get(user)?.avatar ?? null),
    avatars: (ids) => Promise.resolve(new Map(ids.flatMap((id) => (records.get(id)?.avatar == null ? [] : [[id, records.get(id)?.avatar ?? ''] as const])))),
    setAvatar: (user, next) => {
      records.set(user, { ...(records.get(user) ?? blank(user)), avatar: next });
      return Promise.resolve();
    },
    noteLogin: (user, at) => {
      const had = records.get(user.id) ?? blank(user.id);
      records.set(user.id, { ...had, email: user.email, name: user.name, picture: user.picture, createdAt: had.createdAt ?? user.createdAt ?? at, lastLoginAt: at });
      return Promise.resolve();
    },
    find: (user) => Promise.resolve(records.get(user) ?? null),
    list: () => Promise.resolve([...records.values()].sort((a, b) => (b.lastLoginAt ?? '').localeCompare(a.lastLoginAt ?? ''))),
  };
}
