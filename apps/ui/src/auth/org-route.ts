import type { QueryClient } from '@tanstack/react-query';
import { switchOrganization } from '../api/auth.js';
import { activeAccount } from './account.js';


export { isOrganizationId, splitOrganization } from './org-segment.js';

let routed: string | null = null;

export function noteRoutedOrganization(organization: string | null): void {
  routed = organization;
}

export const routedOrganization = (): string | null => routed;

export const currentOrganization = (): string | null => activeAccount()?.organization ?? null;

export const organizationHome = (organization: string): string => `#/${organization}`;

export async function enterOrganization(client: QueryClient, organization: string, hash = organizationHome(organization)): Promise<void> {
  if (currentOrganization() !== organization) await switchOrganization(organization);
  client.clear();
  window.location.hash = hash;
}
