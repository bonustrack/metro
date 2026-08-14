export const MAX_LABEL = 80;

const ELLIPSIS = '…';

function printable(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out;
}

export function runLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = printable(raw).replace(/\s+/g, ' ').trim();
  if (clean === '') return null;
  if (clean.length <= MAX_LABEL) return clean;
  return clean.slice(0, MAX_LABEL - 1).trimEnd() + ELLIPSIS;
}
