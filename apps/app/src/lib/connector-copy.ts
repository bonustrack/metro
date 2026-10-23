import type { OrganizationRow } from '@metro-labs/client/api/auth';
import type { CopiedOrgConnector } from '@metro-labs/client/api/org-connectors';
import { namedSegment } from '@metro-labs/client/auth/org-segment';

export const copyTargets = (organizations: OrganizationRow[], source: string | null): OrganizationRow[] =>
  source === null ? [] : organizations.filter((row) => row.id !== source && row.role === 'admin');

export const copyOrganizationName = (row: OrganizationRow): string => row.name ?? row.slug ?? row.id;

export const copyTarget = (targets: OrganizationRow[], picked: string): OrganizationRow | undefined =>
  targets.find((row) => row.id === picked);

export function copiedConnectorHash(result: CopiedOrgConnector, destination: OrganizationRow): string {
  return `#/${namedSegment(result.organization, destination.slug)}/organization/connectors/${result.connector.id}/settings`;
}
