import { isRecord } from '@metro-labs/core/is-record';
import { GatewayError } from './forward.js';
import type { KeySpend } from './usage.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api';
const KEY_TIMEOUT_MS = 10_000;

const nullableAmount = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null);

export async function openrouterKey(apiKey: string, base = OPENROUTER_BASE, fetchImpl: typeof fetch = fetch): Promise<KeySpend> {
  const res = await fetchImpl(`${base}/v1/key`, {
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(KEY_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new GatewayError(res.status, 'api_error', `OpenRouter would not describe the stored key (${String(res.status)})`);
  }
  const body: unknown = await res.json();
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  const spent = nullableAmount(data.usage);
  if (spent === null) throw new GatewayError(502, 'api_error', 'OpenRouter answered with no spend for the key');
  return { limit: nullableAmount(data.limit), remaining: nullableAmount(data.limit_remaining), spent };
}
