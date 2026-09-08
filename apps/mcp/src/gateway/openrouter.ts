import { GatewayError } from './forward.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api';
const MODELS_MAX = 2000;

export interface OpenRouterModel {
  id: string;
  name: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function modelOf(entry: unknown): OpenRouterModel | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const row = entry as { id?: unknown; name?: unknown };
  const id = str(row.id);
  return id === '' ? null : { id, name: str(row.name) || id };
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
