const PREVIEW_MAX = 300;
const FIELD_MAX = 160;
const LEAD = ['text', 'emoji', 'name', 'bio', 'question', 'address', 'message_id', 'query'];

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function valueText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string');
    if (items.length > 0) return items.join(', ');
    return value.length > 0 ? `${String(value.length)} item(s)` : undefined;
  }
  return undefined;
}

function whereOf(line: unknown): string | undefined {
  if (typeof line !== 'string' || line === '') return undefined;
  const tail = line.split('/').slice(4).join('/');
  return tail === '' ? undefined : `in ${tail}`;
}

export function previewArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const where = whereOf(args.line);
  if (where !== undefined) parts.push(where);
  const keys = [...LEAD, ...Object.keys(args).filter((k) => !LEAD.includes(k))];
  for (const key of keys) {
    if (key === 'line' || key === 'account' || key === 'station') continue;
    if (key === 'attachments' && Array.isArray(args.attachments)) {
      parts.push(`${String(args.attachments.length)} file(s)`);
      continue;
    }
    const text = valueText(args[key]);
    if (text === undefined) continue;
    parts.push(key === 'text' ? `"${shorten(text, FIELD_MAX)}"` : `${key} ${shorten(text, FIELD_MAX)}`);
  }
  return shorten(parts.join(', '), PREVIEW_MAX);
}
