import { AGENT_PAGES, isSlugSegment, RESERVED_SEGMENTS } from '@metro-labs/core/route-segments';
import { activeAccount } from './account.js';

export { RESERVED_SEGMENTS, SLUG_RE } from '@metro-labs/core/route-segments';

const ORG_RE = /^org_[A-Za-z0-9]{10,64}$/;

export const namedSegment = (id: string, slug: string | null): string =>
  slug === null || RESERVED_SEGMENTS.has(slug) ? id : slug;

export const isOrganizationId = (segment: string): boolean => ORG_RE.test(segment);

export const isOrganizationSlug = isSlugSegment;

function leadsWithOrganization(first: string, second: string): boolean {
  if (isOrganizationId(first)) return true;
  return isOrganizationSlug(first) && (first === activeAccount()?.organizationSlug || !AGENT_PAGES.has(second));
}

export function splitOrganization(hash: string): { organization: string | null; rest: string } {
  const raw = hash.replace(/^#?\/?/, '');
  const cut = raw.indexOf('/');
  const first = cut === -1 ? raw : raw.slice(0, cut);
  const rest = cut === -1 ? '' : raw.slice(cut + 1);
  const second = rest.split('/')[0] ?? '';
  if (!leadsWithOrganization(first, second)) return { organization: null, rest: hash };
  return { organization: first, rest: `#/${rest}` };
}
