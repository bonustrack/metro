const ORG_RE = /^org_[A-Za-z0-9]{10,64}$/;

export const isOrganizationId = (segment: string): boolean => ORG_RE.test(segment);

export function splitOrganization(hash: string): { organization: string | null; rest: string } {
  const raw = hash.replace(/^#?\/?/, '');
  const cut = raw.indexOf('/');
  const first = cut === -1 ? raw : raw.slice(0, cut);
  if (!isOrganizationId(first)) return { organization: null, rest: hash };
  const rest = cut === -1 ? '' : raw.slice(cut + 1);
  return { organization: first, rest: `#/${rest}` };
}
