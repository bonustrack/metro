import { ApiError } from '@metro-labs/http/api-error';
import { parseSlug, slugify, withSuffix, type SlugStore } from '../src/slug.ts';

export function memorySlugs(): SlugStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const taken = (slug: string, except?: string): boolean => [...rows.entries()].some(([id, s]) => s === slug && id !== except);
  return {
    rows,
    ensure: (organization, name) => {
      const held = rows.get(organization);
      if (held !== undefined) return Promise.resolve(held);
      const base = slugify(name ?? organization);
      let candidate = base;
      for (let n = 2; taken(candidate); n += 1) candidate = withSuffix(base, n);
      rows.set(organization, candidate);
      return Promise.resolve(candidate);
    },
    set: (organization, raw) => {
      const slug = parseSlug(raw);
      if (taken(slug, organization)) return Promise.reject(new ApiError('that slug is taken', 409));
      rows.set(organization, slug);
      return Promise.resolve(slug);
    },
    find: (slug) => Promise.resolve([...rows.entries()].find(([, s]) => s === slug.toLowerCase())?.[0] ?? null),
  };
}
