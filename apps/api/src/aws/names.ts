const SLUG_MAX = 30;
const NODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const NODE_CHARS = 6;

export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

export function randomNodeName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NODE_CHARS));
  return `metro-${[...bytes].map((b) => NODE_ALPHABET[b % NODE_ALPHABET.length] ?? 'x').join('')}`;
}

export const hostOf = (node: string, tailnet: string): string =>
  `${node}.${tailnet.replace(/^\.+|\.+$/g, '')}`;
