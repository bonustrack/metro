import type { AdminAgent } from '../../lib/admin-agents.js';
import { adminOrganizations, type AdminOrganization } from '../../lib/admin-people.js';
import { useAdminAgents, useAdminOrganizations } from '../../lib/admin-queries.js';
import { useOrganizationsQuery } from '../../lib/queries.js';

export interface OrganizationRows {
  rows: AdminOrganization[] | undefined;
  agents: AdminAgent[];
  error: Error | null;
  refetch: () => unknown;
}

export function useAdminOrganizationRows(now: number): OrganizationRows {
  const organizations = useAdminOrganizations();
  const mine = useOrganizationsQuery();
  const live = useAdminAgents(now);
  const everyAgent = live.everyAgent.data;
  const rows = organizations.data === undefined || everyAgent === undefined ? undefined : adminOrganizations(organizations.data, everyAgent, mine.data ?? null, live.rows);
  return {
    rows,
    agents: live.rows,
    error: organizations.error ?? live.everyAgent.error,
    refetch: () => Promise.all([organizations.refetch(), live.everyAgent.refetch()]),
  };
}
