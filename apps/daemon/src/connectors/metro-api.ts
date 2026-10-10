import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { signBoxRequest } from '@metro-labs/http/box-signature';
import type { BoxKey } from './box-key.js';

const TIMEOUT_MS = 15_000;

export type BoxFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MetroApi {
  base: string;
  fetch: BoxFetch;
  now: () => number;
}

export const METRO_API: MetroApi = {
  base: 'https://api.metro.box',
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
};

function refusal(status: number, value: unknown): ApiError {
  const said = isRecord(value) && typeof value.error === 'string' && value.error.length <= 300 ? value.error : `api.metro.box answered ${String(status)}`;
  return new ApiError(said, status >= 500 ? 503 : 400);
}

export async function boxCall(api: MetroApi, key: BoxKey, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = new URL(path, api.base);
  const method = body === undefined ? 'GET' : 'POST';
  const text = body === undefined ? '' : JSON.stringify(body);
  const authorization = signBoxRequest({ method, host: url.host, path: `${url.pathname}${url.search}`, body: Buffer.from(text, 'utf8') }, key.signing, key.keyId, api.now());
  let response: Response;
  try {
    response = await api.fetch(url.toString(), {
      method,
      headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: text }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError('Metro could not reach api.metro.box. Try again.', 503);
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw refusal(response.status, value);
  if (!isRecord(value)) throw new ApiError('api.metro.box sent an answer Metro cannot read.', 503);
  return value;
}
