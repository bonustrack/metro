import { isRecord } from '@metro-labs/core/is-record';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { stringOf } from '@metro-labs/http/api-http';

export interface ListedModel {
  id: string;
  name: string;
  price?: { prompt: number | null; completion: number | null };
  zdr?: boolean;
  context?: number;
}

const TIMEOUT_MS = 10_000;
export const ROUTEWAY_API = 'https://api.routeway.ai/v1';
const MESSAGES = '/v1/messages';
const USER_AGENT = 'metro (+https://metro.box)';
const LIST_MAX = 2000;
const PER_MILLION = 1_000_000;

export const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ accept: 'application/json', 'user-agent': USER_AGENT, ...extra });

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

export const isJson = (res: Response): boolean => (res.headers.get('content-type') ?? '').includes('application/json');

function perToken(raw: unknown): number | null {
  const each = isRecord(raw) ? raw.price_per_million_t : undefined;
  const value = typeof each === 'number' ? each : typeof each === 'string' && each.trim() !== '' ? Number(each) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value / PER_MILLION : null;
}

const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);

const listed = (entry: Record<string, unknown>): boolean =>
  entry.available === true && strings(entry.endpoints).includes(MESSAGES) && strings(entry.supported_parameters).includes('tools');

function routewayEntry(entry: unknown): { model: ListedModel; created: number }[] {
  if (!isRecord(entry) || stringOf(entry.id) === '' || !listed(entry)) return [];
  const id = stringOf(entry.id);
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  const context = positive(entry.context_length);
  const model: ListedModel = {
    id,
    name: stringOf(entry.short_name) || stringOf(entry.name) || id,
    price: { prompt: perToken(pricing.input), completion: perToken(pricing.output) },
    ...(context === null ? {} : { context }),
  };
  return [{ model, created: positive(entry.created) ?? 0 }];
}

export async function routewayModels(fetchImpl: FetchLike): Promise<ListedModel[]> {
  const res = await fetchImpl(`${ROUTEWAY_API}/models`, { headers: headers(), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok || !isJson(res)) {
    await res.body?.cancel();
    throw new ApiError(`Routeway would not list its models (${String(res.status)})`, 503);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.data)) throw new ApiError('Routeway answered with no model list', 503);
  return body.data
    .flatMap(routewayEntry)
    .sort((a, b) => b.created - a.created || a.model.id.localeCompare(b.model.id))
    .slice(0, LIST_MAX)
    .map((entry) => entry.model);
}
