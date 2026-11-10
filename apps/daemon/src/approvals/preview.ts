import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@metro-labs/core/is-record';

const INLINE_MAX = 256;
const EDGE = 64;

export const PREVIEW_MAX = 100_000;

const inlineData = (data: string): string =>
  data.length <= INLINE_MAX ? data : `${data.slice(0, EDGE)}\n⋯ ${String(data.length - 2 * EDGE)} code points elided ⋯\n${data.slice(-EDGE)}`;

const withoutBytes = (file: unknown): unknown => (isRecord(file) && typeof file.data === 'string' ? { ...file, data: inlineData(file.data) } : file);

export function previewText(args: Record<string, unknown>): string {
  const files = args.attachments;
  return JSON.stringify(Array.isArray(files) ? { ...args, attachments: files.map(withoutBytes) } : args);
}

export function previewInput(preview: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(preview);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const previewMatches = (preview: string, args: Record<string, unknown>): boolean => isDeepStrictEqual(previewInput(preview), args);
