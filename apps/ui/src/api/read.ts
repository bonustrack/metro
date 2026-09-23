export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export const filled = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export const str = (value: unknown): string => (typeof value === 'string' ? value : '');
