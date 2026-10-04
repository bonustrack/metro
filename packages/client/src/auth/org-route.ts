import { fetchOrganizations, switchOrganization } from '../api/auth.js';
import { location } from '../platform.js';
import { activeAccount, type Account } from './account.js';
import { isOrganizationId, namedSegment } from './org-segment.js';

export { isOrganizationId, isOrganizationSlug, splitOrganization } from './org-segment.js';

let routed: string | null = null;

export function noteRoutedOrganization(organization: string | null): void {
  routed = organization;
}

export const routedOrganization = (): string | null => routed;

export const currentOrganization = (): string | null => activeAccount()?.organization ?? null;

const names = (account: Account | null): string | null => {
  const organization = account?.organization ?? null;
  return organization === null ? null : namedSegment(organization, account?.organizationSlug ?? null);
};

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

export async function enterOrganization(organization: string, prefetch: (organization: string) => Promise<void>, page = ''): Promise<void> {
  if (currentOrganization() !== organization) await switchOrganization(organization);
  await prefetch(organization);
  routed = null;
  location().push(`#/${names(activeAccount()) ?? organization}${page}`);
}
