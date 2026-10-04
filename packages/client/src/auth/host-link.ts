import type { OrganizationRow } from '../api/auth.js';
import { namedSegment, splitOrganization } from './org-segment.js';

type HostTarget =
  | { kind: 'listed'; organization: string; agent: string }
  | { kind: 'add'; organization: string | null }
  | { kind: 'foreign' };

function listedIn(org: OrganizationRow, host: string): HostTarget | null {
  const agent = org.agents?.find((a) => a.host.toLowerCase() === host.toLowerCase());
  return agent === undefined ? null : { kind: 'listed', organization: namedSegment(org.id, org.slug), agent: namedSegment(agent.id, agent.slug) };
}

export function hostTarget(orgs: OrganizationRow[], host: string, owner: string | null, current: string | null): HostTarget {
  if (owner !== null) {
    const home = orgs.find((o) => o.id === owner);
    if (home === undefined) return { kind: 'foreign' };
    return listedIn(home, host) ?? { kind: 'add', organization: home.id };
  }
  const ranked = [...orgs.filter((o) => o.id === current), ...orgs.filter((o) => o.id !== current)];
  for (const org of ranked) {
    const found = listedIn(org, host);
    if (found !== null) return found;
  }
  return { kind: 'add', organization: current };
}

export function hostHash(hash: string, segment: string): string {
  const tail = splitOrganization(hash).rest.replace(/^#?\/?[^/]*/, '');
  return `#/${segment}${tail}`;
}
