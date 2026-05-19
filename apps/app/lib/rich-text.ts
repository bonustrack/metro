/** Split text into plain / link parts. Handles bare URLs and `[label](href)`. */

export interface TextPart { kind: 'text'; value: string }
export interface LinkPart { kind: 'link'; label: string; href: string }
export type Part = TextPart | LinkPart;

const PATTERN = /(\[([^\]]+)\]\(([^)\s]+)\))|(\bhttps?:\/\/[^\s)>]+)/g;

export function parseRichText(input: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of input.matchAll(PATTERN)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: 'text', value: input.slice(last, idx) });
    if (m[1]) out.push({ kind: 'link', label: m[2], href: m[3] });
    else if (m[4]) out.push({ kind: 'link', label: m[4], href: m[4] });
    last = idx + m[0].length;
  }
  if (last < input.length) out.push({ kind: 'text', value: input.slice(last) });
  return out;
}
