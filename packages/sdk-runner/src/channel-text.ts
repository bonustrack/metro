import type { ChatSender } from '@metro-labs/core/chat';
import { isRecord } from '@metro-labs/core/is-record';
import type { MissingFile, TurnFile } from './chat-files.js';

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

const KB = 1024;
const MB = 1024 * KB;

function sizeText(bytes: number): string {
  if (bytes < KB) return `${String(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
  return bytes < MB ? `${(bytes / KB).toFixed(1)} KB` : `${(bytes / MB).toFixed(1)} MB`;
}

const described = (file: MissingFile): string => `"${attr(file.name)}" (${attr(file.type)}, ${sizeText(file.size)})`;

const fileLine = (file: TurnFile): string => `[file: ${described(file)} at ${attr(file.path)}]`;

const missingLine = (file: MissingFile): string => `[file not received: ${described(file)}]`;

export function chatMessageText(from: ChatSender | null, text: string, files: readonly TurnFile[] = [], missing: readonly MissingFile[] = []): string {
  const lines = [...files.map(fileLine), ...missing.map(missingLine)];
  const body = [...(text.trim() === '' && lines.length > 0 ? [] : [unwrapped(text)]), ...lines].join('\n');
  if (from === null) return body;
  const email = from.email === null ? '' : ` email="${attr(from.email)}"`;
  return `<chat-message from="${attr(from.name)}"${email} verified="true">\n${body}\n</chat-message>`;
}

export interface ChannelEvent {
  content: string;
  meta: Record<string, unknown>;
}

export function channelEvent(params: unknown): ChannelEvent | null {
  if (!isRecord(params) || typeof params.content !== 'string') return null;
  return { content: params.content, meta: isRecord(params.meta) ? params.meta : {} };
}
