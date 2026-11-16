import type { Directory, OrganizationSummary } from '../src/auth/directory.ts';

export function namedOrganizations(rows: OrganizationSummary[]): Pick<Directory, 'listOrganizations' | 'organizationName'> {
  return {
    listOrganizations: () => Promise.resolve(rows),
    organizationName: (id) => Promise.resolve(rows.find((o) => o.id === id)?.name ?? null),
  };
}
