import type { ChatSender } from '@metro-labs/core/chat';
import { isRecord } from '@metro-labs/core/is-record';

const KEY = /^[A-Za-z0-9_]+$/;

const attr = (value: string): string => value.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const shown = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

export function channelText(source: string, content: string, meta: Record<string, unknown>): string {
  const attrs = Object.entries(meta)
    .filter((entry): entry is [string, string | number | boolean] => KEY.test(entry[0]) && shown(entry[1]))
    .map(([key, value]) => ` ${key}="${attr(String(value))}"`)
    .join('');
  return `<channel source="${attr(source)}"${attrs}>\n${content}\n</channel>`;
}

const unwrapped = (text: string): string => text.replace(/[<\uFF1C\uFE64](?=[\s/\uFF0F]*chat[\p{Pd}\p{Cf}\s_]*message)/giu, '&lt;');

export function chatMessageText(from: ChatSender | null, text: string): string {
  if (from === null) return unwrapped(text);
  const email = from.email === null ? '' : ` email="${attr(from.email)}"`;
  return `<chat-message from="${attr(from.name)}"${email} verified="true">\n${unwrapped(text)}\n</chat-message>`;
}

export interface ChannelEvent {
  content: string;
  meta: Record<string, unknown>;
}

export function channelEvent(params: unknown): ChannelEvent | null {
  if (!isRecord(params) || typeof params.content !== 'string') return null;
  return { content: params.content, meta: isRecord(params.meta) ? params.meta : {} };
}
