import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@metro-labs/core/is-record';

const ELIDED = '\u0000';

const CODE_POINTS = /(?:\\n|\n)⋯ \d+ code points elided ⋯(?:\\n|\n)/g;
const FIELD_BLOCK = /[\s,]*(?:\\n|\n)?\s*⋯[^]*$/;

export interface ReadPreview {
  input: Record<string, unknown> | undefined;
  partial: boolean;
}

function parsedRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function readPreview(preview: string): ReadPreview {
  const text = preview.replace(CODE_POINTS, '\\u0000');
  const whole = parsedRecord(text);
  if (whole !== undefined) return { input: whole, partial: false };
  if (!text.includes('⋯')) return { input: undefined, partial: false };
  const head = text.replace(FIELD_BLOCK, '').replace(/[\s,]*$/, '');
  const input = parsedRecord(`${head}}`) ?? parsedRecord(head);
  return { input, partial: input !== undefined };
}

export const shownValue = (text: string): string => text.split(ELIDED).join('…');

function stringMatches(shown: string, real: string): boolean {
  if (!shown.includes(ELIDED)) return shown === real;
  const [first = '', ...rest] = shown.split(ELIDED);
  const last = rest.pop() ?? '';
  if (!real.startsWith(first) || !real.endsWith(last)) return false;
  let at = first.length;
  for (const part of rest) {
    const found = real.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return at <= real.length - last.length;
}

function valueMatches(shown: unknown, real: unknown): boolean {
  if (typeof shown === 'string') return typeof real === 'string' && stringMatches(shown, real);
  if (Array.isArray(shown))
    return Array.isArray(real) && shown.length === real.length && shown.every((v, i) => valueMatches(v, real[i]));
  if (isRecord(shown)) return isRecord(real) && recordMatches(shown, real, false);
  return isDeepStrictEqual(shown, real);
}

function recordMatches(shown: Record<string, unknown>, real: Record<string, unknown>, partial: boolean): boolean {
  const keys = Object.keys(shown);
  if (!partial && keys.length !== Object.keys(real).length) return false;
  return keys.every((key) => key in real && valueMatches(shown[key], real[key]));
}

export function previewMatches(preview: string, args: Record<string, unknown>): boolean {
  const { input, partial } = readPreview(preview);
  return input !== undefined && recordMatches(input, args, partial);
}
