import { isRecord } from '@metro-labs/core/is-record';

const KEY = /^[A-Za-z0-9_]+$/;

const attr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const shown = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

export function channelText(source: string, content: string, meta: Record<string, unknown>): string {
  const attrs = Object.entries(meta)
    .filter((entry): entry is [string, string | number | boolean] => KEY.test(entry[0]) && shown(entry[1]))
    .map(([key, value]) => ` ${key}="${attr(String(value))}"`)
    .join('');
  return `<channel source="${attr(source)}"${attrs}>\n${content}\n</channel>`;
}

export interface ChannelEvent {
  content: string;
  meta: Record<string, unknown>;
}

export function channelEvent(params: unknown): ChannelEvent | null {
  if (!isRecord(params) || typeof params.content !== 'string') return null;
  return { content: params.content, meta: isRecord(params.meta) ? params.meta : {} };
}
