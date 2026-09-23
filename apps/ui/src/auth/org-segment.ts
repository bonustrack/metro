const ORG_RE = /^org_[A-Za-z0-9]{10,64}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['docs', 'settings', 'connect', 'launch', 'login', 'signup', 'waitlist', 'auth', 'members', 'organization', 'api', 'admin', 'metro', 'new', 'connector', 'connectors']);

export const isOrganizationId = (segment: string): boolean => ORG_RE.test(segment);

export const isOrganizationSlug = (segment: string): boolean => SLUG_RE.test(segment) && !RESERVED_SEGMENTS.has(segment);

const AGENT_PAGES = new Set(['server', 'settings', 'terminal', 'model', 'harness', 'claude', 'skills', 'skill', 'channels', 'channel', 'connectors', 'connector', 'sessions', 'memory']);

function leadsWithOrganization(first: string, second: string): boolean {
  if (isOrganizationId(first)) return true;
  return isOrganizationSlug(first) && !AGENT_PAGES.has(second);
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
