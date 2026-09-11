import { isRecord } from '@metro-labs/core/is-record';
import { GatewayError } from './forward.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api';
const MODELS_MAX = 2000;

export interface OpenRouterModel {
  id: string;
  name: string;
  prompt: number | null;
  completion: number | null;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function price(raw: unknown): number | null {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function modelOf(entry: unknown): OpenRouterModel | null {
  if (!isRecord(entry)) return null;
  const id = str(entry.id);
  if (id === '') return null;
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  return { id, name: str(entry.name) || id, prompt: price(pricing.prompt), completion: price(pricing.completion) };
}

export async function openrouterModels(base = OPENROUTER_BASE, fetchImpl: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  const res = await fetchImpl(`${base}/v1/models`, { headers: { accept: 'application/json' }, redirect: 'manual' });
  if (!res.ok) throw new GatewayError(res.status, 'api_error', `OpenRouter would not list its models (${String(res.status)})`);
  const body: unknown = await res.json();
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new GatewayError(502, 'api_error', 'OpenRouter answered with no model list');
  return data
    .map(modelOf)
    .filter((model): model is OpenRouterModel => model !== null)
    .slice(0, MODELS_MAX)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function openrouterZdrModels(base = OPENROUTER_BASE, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${base}/v1/endpoints/zdr`, { headers: { accept: 'application/json' }, redirect: 'manual' });
  if (!res.ok) throw new GatewayError(res.status, 'api_error', `OpenRouter would not list its zero data retention endpoints (${String(res.status)})`);
  const body: unknown = await res.json();
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new GatewayError(502, 'api_error', 'OpenRouter answered with no endpoint list');
  const ids = new Set<string>();
  for (const entry of data) if (isRecord(entry) && str(entry.model_id) !== '') ids.add(str(entry.model_id));
  return [...ids].sort();
}
