import { errMsg, log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { headers, isJson, ROUTEWAY_API } from '@metro-labs/connectors/model-lists';

const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 10_000;
const CHECK_MODEL = 'claude-haiku-5.5';
const KEY_REFUSED = 'Routeway refused this key, so it was not saved. Copy the key again from https://routeway.ai/dashboard/api-keys and paste it here.';
const KEY_UNCHECKED = 'Metro could not check this key with Routeway, so it was not saved. Try again in a moment.';

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
