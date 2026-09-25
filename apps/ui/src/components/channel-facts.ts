import { isRecord } from '../api/read.js';

export function factLabel(label: string): string {
  const words = label.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
  return words === '' ? label : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

function nameOf(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return typeof value.members === 'number' ? `${value.name} (${String(value.members)} people)` : value.name;
}

function parsed(value: string): unknown {
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function factValue(value: string): string {
  const data = parsed(value);
  if (Array.isArray(data)) {
    const names = data.map(nameOf).filter((n): n is string => n !== null);
    return names.length > 0 ? names.join(', ') : value;
  }
  return nameOf(data) ?? value;
}
