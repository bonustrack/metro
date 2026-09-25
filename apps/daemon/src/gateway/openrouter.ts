import { isRecord } from '@metro-labs/core/is-record';
import { GatewayError } from './forward.js';
import { stringOf } from '@metro-labs/http/api-http';

export const OPENROUTER_BASE = 'https://openrouter.ai/api';
const MODELS_MAX = 2000;

export interface OpenRouterModel {
  id: string;
  name: string;
  prompt: number | null;
  completion: number | null;
  created: number | null;
}


function price(raw: unknown): number | null {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function released(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function modelOf(entry: unknown): OpenRouterModel | null {
  if (!isRecord(entry)) return null;
  const id = stringOf(entry.id);
  if (id === '') return null;
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  return {
    id,
    name: stringOf(entry.name) || id,
    prompt: price(pricing.prompt),
    completion: price(pricing.completion),
    created: released(entry.created),
  };
}

function newestFirst(a: OpenRouterModel, b: OpenRouterModel): number {
  const when = (b.created ?? 0) - (a.created ?? 0);
  return when !== 0 ? when : a.id.localeCompare(b.id);
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
    .sort(newestFirst)
    .slice(0, MODELS_MAX);
}

export interface OpenRouterCredits {
  total: number;
  spent: number;
}

export async function openrouterCredits(
  apiKey: string,
  base = OPENROUTER_BASE,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterCredits> {
  const res = await fetchImpl(`${base}/v1/credits`, {
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    redirect: 'manual',
  });
  if (!res.ok) throw new GatewayError(res.status, 'api_error', `OpenRouter would not report the credits (${String(res.status)})`);
  const body: unknown = await res.json();
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  const total = Number(data.total_credits);
  const spent = Number(data.total_usage);
  if (!Number.isFinite(total) || !Number.isFinite(spent)) throw new GatewayError(502, 'api_error', 'OpenRouter answered with no credit figures');
  return { total, spent };
}

export async function openrouterZdrModels(base = OPENROUTER_BASE, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${base}/v1/endpoints/zdr`, { headers: { accept: 'application/json' }, redirect: 'manual' });
  if (!res.ok) throw new GatewayError(res.status, 'api_error', `OpenRouter would not list its zero data retention endpoints (${String(res.status)})`);
  const body: unknown = await res.json();
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new GatewayError(502, 'api_error', 'OpenRouter answered with no endpoint list');
  const ids = new Set<string>();
  for (const entry of data) if (isRecord(entry) && stringOf(entry.model_id) !== '') ids.add(stringOf(entry.model_id));
  return [...ids].sort();
}
