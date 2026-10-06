import { userOrganizations, type UserOrganization, type WorkosConfig } from '../auth/workos.js';
import type { UserStore } from '../users.js';

type Memberships = (config: WorkosConfig, userId: string) => Promise<UserOrganization[]>;

export async function gmailUserAllowed(
  users: Pick<UserStore, 'find'>,
  config: WorkosConfig | null,
  userId: string,
  organization: string,
  memberships: Memberships = userOrganizations,
): Promise<boolean> {
  if (config === null) return false;
  const user = await users.find(userId);
  if (user === null || user.status === 'rejected') return false;
  return (await memberships(config, userId)).some((entry) => entry.id === organization);
}
