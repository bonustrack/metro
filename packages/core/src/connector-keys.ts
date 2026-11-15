const KEY_MAX = 63;
const FALLBACK = 'connector';

export interface Named {
  id: string;
  name: string;
}

export function slugOf(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KEY_MAX)
    .replace(/-+$/g, '');
  return slug === '' ? FALLBACK : slug;
}

const suffixed = (slug: string, n: number): string => `${slug.slice(0, KEY_MAX - 1 - String(n).length).replace(/-+$/g, '')}-${String(n)}`;

export function connectorKeys(rows: Named[]): Map<string, string> {
  const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bases = new Map(ordered.map((row) => [row.id, slugOf(row.name)]));
  const taken = new Set<string>();
  const keys = new Map<string, string>();
  const later: Named[] = [];
  for (const row of ordered) {
    const base = bases.get(row.id) ?? FALLBACK;
    if (taken.has(base)) later.push(row);
    else {
      taken.add(base);
      keys.set(row.id, base);
    }
  }
  const reserved = new Set(bases.values());
  for (const row of later) {
    const base = bases.get(row.id) ?? FALLBACK;
    let n = 2;
    while (taken.has(suffixed(base, n)) || reserved.has(suffixed(base, n))) n += 1;
    taken.add(suffixed(base, n));
    keys.set(row.id, suffixed(base, n));
  }
  return keys;
}
