import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { stringOf } from '@metro-labs/http/api-http';
import type { ListedModel } from './list-cache.js';

const ROUTEWAY_API = 'https://api.routeway.ai/v1';
const MESSAGES = '/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const USER_AGENT = 'metro (+https://metro.box)';
const TIMEOUT_MS = 10_000;
const LIST_MAX = 2000;
const PER_MILLION = 1_000_000;
const CHECK_MODEL = 'claude-haiku-5.5';
const KEY_REFUSED = 'Routeway refused this key, so it was not saved. Copy the key again from https://routeway.ai/dashboard/api-keys and paste it here.';
const KEY_UNCHECKED = 'Metro could not check this key with Routeway, so it was not saved. Try again in a moment.';

const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ accept: 'application/json', 'user-agent': USER_AGENT, ...extra });

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

const isJson = (res: Response): boolean => (res.headers.get('content-type') ?? '').includes('application/json');

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

async function countWith(apiKey: string, fetchImpl: FetchLike): Promise<Response> {
  try {
    return await fetchImpl(`${ROUTEWAY_API}/messages/count_tokens`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': apiKey }),
      body: JSON.stringify({ model: CHECK_MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'models: Routeway could not be reached to check a key');
    throw new ApiError(KEY_UNCHECKED, 503);
  }
}

export async function checkRoutewayKey(apiKey: string, fetchImpl: FetchLike): Promise<void> {
  const res = await countWith(apiKey, fetchImpl);
  await res.body?.cancel();
  if (res.ok) return;
  const routeway = isJson(res);
  if (routeway && (res.status === 401 || res.status === 403)) throw new ApiError(`${KEY_REFUSED} (${String(res.status)})`, 400);
  if (routeway && res.status >= 400 && res.status < 500 && res.status !== 429) {
    log.info({ status: res.status }, 'models: Routeway took the key but not the check request, so the key is kept');
    return;
  }
  throw new ApiError(`${KEY_UNCHECKED} (Routeway answered ${String(res.status)})`, 503);
}
