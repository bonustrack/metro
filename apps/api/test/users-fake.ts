import type { UserStore } from '../src/users.ts';

export function memoryUsers(): UserStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    avatar: (user) => Promise.resolve(rows.get(user) ?? null),
    avatars: (ids) => Promise.resolve(new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id) ?? ''] as const] : [])))),
    setAvatar: (user, next) => {
      if (next === null) rows.delete(user);
      else rows.set(user, next);
      return Promise.resolve();
    },
  };
}
