import type { QueryClient } from '@tanstack/react-query';
import { fetchOrganizations, switchOrganization } from '../api/auth.js';
import { activeAccount, type Account } from './account.js';
import { isOrganizationId } from './org-segment.js';

export { isOrganizationId, isOrganizationSlug, splitOrganization } from './org-segment.js';

let routed: string | null = null;

export function noteRoutedOrganization(organization: string | null): void {
  routed = organization;
}

export const routedOrganization = (): string | null => routed;

export const currentOrganization = (): string | null => activeAccount()?.organization ?? null;

const names = (account: Account | null): string | null => account?.organizationSlug ?? account?.organization ?? null;

export const isCurrentOrganization = (segment: string, account: Account | null = activeAccount()): boolean =>
  account !== null && (segment === account.organization || segment === account.organizationSlug);

export function organizationSegment(): string | null {
  const account = activeAccount();
  if (routed === null) return names(account);
  return isCurrentOrganization(routed, account) ? names(account) : routed;
}

export async function resolveOrganization(segment: string): Promise<string | null> {
  if (isOrganizationId(segment)) return segment;
  const mine = await fetchOrganizations();
  return mine.find((o) => o.slug === segment)?.id ?? null;
}

export async function enterOrganization(client: QueryClient, organization: string, page = ''): Promise<void> {
  if (currentOrganization() !== organization) await switchOrganization(organization);
  client.clear();
  routed = null;
  window.location.hash = `#/${names(activeAccount()) ?? organization}${page}`;
}
