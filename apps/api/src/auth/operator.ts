import { ApiError } from '@metro-labs/http/api-error';
import type { Session } from '@metro-labs/http/workos-token';
import type { UserStore } from '../users.js';

export const OPERATOR_EMAIL = 'admin@stage.box';

export async function isOperator(users: UserStore, session: Session): Promise<boolean> {
  const me = await users.find(session.userId);
  return me?.email?.toLowerCase() === OPERATOR_EMAIL;
}

export async function listUsers(users: UserStore, session: Session): Promise<unknown> {
  if (!(await isOperator(users, session))) throw new ApiError('this page is for the Metro operator', 403);
  const rows = await users.list();
  return {
    users: rows.map((r) => ({ id: r.id, email: r.email, name: r.name, picture: r.avatar ?? r.picture, createdAt: r.createdAt, lastLoginAt: r.lastLoginAt })),
  };
}
