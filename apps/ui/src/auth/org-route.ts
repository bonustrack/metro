import type { QueryClient } from '@tanstack/react-query';
import { switchOrganization } from '../api/auth.js';
import { activeAccount } from './account.js';

const ORG_RE = /^org_[A-Za-z0-9]{10,64}$/;

let routed: string | null = null;

export const isOrganizationId = (segment: string): boolean => ORG_RE.test(segment);

export function splitOrganization(hash: string): { organization: string | null; rest: string } {
  const raw = hash.replace(/^#?\/?/, '');
  const cut = raw.indexOf('/');
  const first = cut === -1 ? raw : raw.slice(0, cut);
  if (!isOrganizationId(first)) return { organization: null, rest: hash };
  const rest = cut === -1 ? '' : raw.slice(cut + 1);
  return { organization: first, rest: `#/${rest}` };
}

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
