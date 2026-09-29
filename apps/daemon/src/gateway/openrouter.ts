import { isRecord } from '@metro-labs/core/is-record';
import { GatewayError } from './forward.js';
import { listCache } from './model-lists.js';
import { stringOf } from '@metro-labs/http/api-http';
import type { KeySpend } from './usage.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api';
const MODELS_MAX = 2000;
const KEY_TIMEOUT_MS = 10_000;

export interface OpenRouterModel {
  id: string;
  name: string;
  prompt: number | null;
  completion: number | null;
  created: number | null;
}

const modelLists = listCache<OpenRouterModel>('openrouter');
const zdrLists = listCache<string>('openrouter-zdr');

function price(raw: unknown): number | null {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function released(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

const strings = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null);

function chatCapable(entry: Record<string, unknown>): boolean {
  const output = strings(isRecord(entry.architecture) ? entry.architecture.output_modalities : undefined);
  const params = strings(entry.supported_parameters);
  return (output === null || output.includes('text')) && (params === null || params.includes('tools'));
}

function modelOf(entry: unknown): OpenRouterModel | null {
  if (!isRecord(entry) || !chatCapable(entry)) return null;
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

async function listModels(base: string, fetchImpl: typeof fetch): Promise<OpenRouterModel[]> {
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

export const openrouterModels = (base = OPENROUTER_BASE, fetchImpl: typeof fetch = fetch): Promise<OpenRouterModel[]> =>
  modelLists.get(base, () => listModels(base, fetchImpl));

const nullableAmount = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null);

export async function openrouterKey(apiKey: string, base = OPENROUTER_BASE, fetchImpl: typeof fetch = fetch): Promise<KeySpend> {
  const res = await fetchImpl(`${base}/v1/key`, {
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(KEY_TIMEOUT_MS),
  });
  if (!res.ok) throw new GatewayError(res.status, 'api_error', `OpenRouter would not describe the stored key (${String(res.status)})`);
  const body: unknown = await res.json();
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  const spent = nullableAmount(data.usage);
  if (spent === null) throw new GatewayError(502, 'api_error', 'OpenRouter answered with no spend for the key');
  return { limit: nullableAmount(data.limit), remaining: nullableAmount(data.limit_remaining), spent };
}

async function listZdr(base: string, fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(`${base}/v1/endpoints/zdr`, { headers: { accept: 'application/json' }, redirect: 'manual' });
  if (!res.ok) throw new GatewayError(res.status, 'api_error', `OpenRouter would not list its zero data retention endpoints (${String(res.status)})`);
  const body: unknown = await res.json();
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new GatewayError(502, 'api_error', 'OpenRouter answered with no endpoint list');
  const ids = new Set<string>();
  for (const entry of data) if (isRecord(entry) && stringOf(entry.model_id) !== '') ids.add(stringOf(entry.model_id));
  return [...ids].sort();
}

export const openrouterZdrModels = (base = OPENROUTER_BASE, fetchImpl: typeof fetch = fetch): Promise<string[]> => zdrLists.get(base, () => listZdr(base, fetchImpl));
