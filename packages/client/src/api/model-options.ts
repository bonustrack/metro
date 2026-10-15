import { isRecord } from '../read.js';

export interface ModelOption {
  id: string;
  name: string;
  price: string;
  zdr: boolean | null;
}

const MATCH_MAX = 40;
const PER_MILLION = 1_000_000;

const amount = (perToken: number): string => {
  const each = perToken * PER_MILLION;
  return `$${String(Number(each.toFixed(each >= 1 ? 2 : 3)))}`;
};

export function priceLabel(prompt: unknown, completion: unknown): string {
  if (typeof prompt !== 'number' || typeof completion !== 'number') return '';
  if (prompt === 0 && completion === 0) return 'Free';
  return `${amount(prompt)} in · ${amount(completion)} out per 1M`;
}

function priceOf(raw: Record<string, unknown>): string {
  if (typeof raw.price === 'string') return raw.price;
  if (isRecord(raw.price)) return priceLabel(raw.price.prompt, raw.price.completion);
  return priceLabel(raw.prompt, raw.completion);
}

export function toModelOptions(body: unknown): ModelOption[] {
  if (!isRecord(body) || !Array.isArray(body.models)) throw new Error('Metro returned an unexpected response.');
  return body.models.flatMap((m: unknown) => {
    if (typeof m === 'string' && m !== '') return [{ id: m, name: m, price: '', zdr: null }];
    if (!isRecord(m) || typeof m.id !== 'string' || m.id === '') return [];
    return [{ id: m.id, name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id, price: priceOf(m), zdr: typeof m.zdr === 'boolean' ? m.zdr : null }];
  });
}

export function matchModels(models: ModelOption[], query: string, limit = MATCH_MAX): ModelOption[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  const hit = (model: ModelOption): boolean => {
    const hay = `${model.id} ${model.name}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  };
  return models.filter(hit).slice(0, limit);
}
