import { ApiError } from '@metro-labs/http/api-error';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const SLUG_MAX = 32;
const SLUG_MIN = 3;

export const RESERVED_SLUGS = new Set(['docs', 'settings', 'connect', 'launch', 'login', 'signup', 'auth', 'members', 'organization', 'api', 'admin', 'metro', 'new']);

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  const padded = base.length < SLUG_MIN ? `${base}${'org'.slice(0, SLUG_MIN - base.length)}` : base;
  return RESERVED_SLUGS.has(padded) ? `${padded}-1` : padded;
}

export function parseSlug(raw: unknown): string {
  const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) throw new ApiError('a slug is 3 to 32 lowercase letters, digits and dashes, not starting or ending with a dash', 400);
  if (RESERVED_SLUGS.has(slug)) throw new ApiError('that slug is reserved', 400);
  return slug;
}

export const withSuffix = (slug: string, n: number): string => `${slug.slice(0, SLUG_MAX - 1 - String(n).length)}-${String(n)}`;

export interface SlugStore {
  ensure: (organization: string, name: string | null) => Promise<string>;
  set: (organization: string, slug: string) => Promise<string>;
  find: (slug: string) => Promise<string | null>;
}
