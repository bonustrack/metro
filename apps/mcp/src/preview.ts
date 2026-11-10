import { canonicalJson } from '@metro-labs/http/args-digest';

export const PREVIEW_MAX = 1000;

export function previewOf(args: Record<string, unknown>): string {
  const points = Array.from(canonicalJson(args));
  return points.length <= PREVIEW_MAX ? points.join('') : `${points.slice(0, PREVIEW_MAX - 1).join('')}…`;
}
