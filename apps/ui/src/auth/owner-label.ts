import { activeAccount } from './account.js';

export function ownerLabel(owner: string | null): string {
  if (owner === null) return 'not set';
  const account = activeAccount();
  if (account?.organization === owner) return account.organizationName ?? owner;
  return owner;
}
