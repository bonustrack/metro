import { fetchOrganizations, switchOrganization, switchRefused } from '../api/auth.js';
import { location } from '../platform.js';
import { AccountChangedError, activeAccount, type Account } from './account.js';
import { isOrganizationId, namedSegment } from './org-segment.js';

export { isOrganizationId, isOrganizationSlug, splitOrganization } from './org-segment.js';

let routed: string | null = null;

export function noteRoutedOrganization(organization: string | null): void {
  routed = organization;
}

export const routedOrganization = (): string | null => routed;

export const currentOrganization = (): string | null => activeAccount()?.organization ?? null;

export async function forOrganization<T>(organization: string | null, run: () => Promise<T>): Promise<T> {
  const same = (): void => {
    if (currentOrganization() !== organization) throw new AccountChangedError();
  };
  same();
  const value = await run();
  same();
  return value;
}

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

async function resolveOrganization(segment: string): Promise<string | null> {
  if (isOrganizationId(segment)) return segment;
  const mine = await fetchOrganizations();
  return mine.find((o) => o.slug === segment)?.id ?? null;
}

export type OrganizationOpening =
  | { kind: 'open'; organization: string }
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'signed-out' }
  | { kind: 'stale' };

const ATTEMPTS = 5;
const NOT_MEMBER = 'you are not a member of that organization';

function openedNow(segment: string, organization: string | null): OrganizationOpening | null {
  const account = activeAccount();
  if (account === null) return { kind: 'signed-out' };
  if (account.organization === null) return null;
  return isCurrentOrganization(segment, account) || account.organization === organization ? { kind: 'open', organization: account.organization } : null;
}

function failedOpen(err: unknown, alive: () => boolean): OrganizationOpening | null {
  if (!alive()) return { kind: 'stale' };
  if (activeAccount() === null) return { kind: 'signed-out' };
  if (switchRefused(err)) return { kind: 'refused', message: err.message };
  if (err instanceof AccountChangedError) return null;
  return { kind: 'failed', message: err instanceof Error ? err.message : 'Could not open that organization.' };
}

async function openStep(segment: string, alive: () => boolean): Promise<OrganizationOpening | string | null> {
  try {
    const organization = await resolveOrganization(segment);
    if (organization === null) return { kind: 'refused', message: NOT_MEMBER };
    if (!alive()) return { kind: 'stale' };
    await switchOrganization(organization);
    return organization;
  } catch (err) {
    return failedOpen(err, alive);
  }
}

export async function openOrganization(segment: string, alive: () => boolean = () => true): Promise<OrganizationOpening> {
  let organization: string | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (!alive()) return { kind: 'stale' };
    const now = openedNow(segment, organization);
    if (now !== null) return now;
    const step = await openStep(segment, alive);
    if (typeof step === 'string') organization = step;
    else if (step !== null) return step;
  }
  if (!alive()) return { kind: 'stale' };
  return openedNow(segment, organization) ?? { kind: 'failed', message: 'Could not open that organization. Try again.' };
}

export async function enterOrganization(organization: string, prefetch: (organization: string) => Promise<void>, page = ''): Promise<void> {
  if (currentOrganization() !== organization) await switchOrganization(organization);
  await prefetch(organization);
  routed = null;
  location().push(`#/${names(activeAccount()) ?? organization}${page}`);
}
