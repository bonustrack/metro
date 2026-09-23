import { isRecord } from '@metro-labs/core/is-record';

const IMAGE_NOTE = '[an image was attached here; this model cannot see it]';

export const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

export const nonEmpty = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const partText = (part: Record<string, unknown>): string => (part.type === 'text' ? stringOf(part.text) : part.type === 'image' ? IMAGE_NOTE : '');

export function resultText(block: Record<string, unknown>): string {
  const content = block.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(isRecord).map(partText).filter((t) => t !== '').join('\n') : '';
  return block.is_error === true ? `[tool error] ${text}` : text;
}
