export interface ChannelMessage {
  text: string;
  from: string | null;
  line: string | null;
  station: string | null;
}

const WRAPPER = /^\s*<channel\s([^>]*)>([\s\S]*?)<\/channel>\s*$/;
const ATTR = /([a-z_]+)="([^"]*)"/g;
const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };

const unescapeAttr = (value: string): string => value.replace(/&(lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m] ?? m);

const filled = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const text = unescapeAttr(value).trim();
  return text === '' || text === '[object Object]' ? null : text;
};

export function parseChannelMessage(text: string): ChannelMessage | null {
  const match = WRAPPER.exec(text);
  if (match === null) return null;
  const attrs: Record<string, string> = {};
  for (const [, name, value] of (match[1] ?? '').matchAll(ATTR)) if (name !== undefined && value !== undefined) attrs[name] = value;
  return {
    text: (match[2] ?? '').trim(),
    from: filled(attrs.from_display_name) ?? filled(attrs.from_name),
    line: filled(attrs.line_name),
    station: filled(attrs.station),
  };
}
