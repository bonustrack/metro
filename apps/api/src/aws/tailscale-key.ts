import { isRecord } from '@metro-labs/core/is-record';
import { AUTH_KEY_RE } from './user-data.js';

const API = 'https://api.tailscale.com/api/v2';
export const BOX_TAG = 'tag:metro-box';
export const KEY_TTL_SECONDS = 3600;
const FETCH_MS = 15_000;

export interface TailscaleClient {
  id: string;
  secret: string;
}

export class TailscaleError extends Error {}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const said = (body: unknown): string => (isRecord(body) && typeof body.message === 'string' ? body.message : '');

async function post(fetchFn: Fetch, url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, { ...init, method: 'POST', signal: AbortSignal.timeout(FETCH_MS) });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = said(body);
    throw new TailscaleError(`Tailscale refused ${what} (HTTP ${String(res.status)}${reason === '' ? '' : `: ${reason}`}).`);
  }
  return isRecord(body) ? body : {};
}

async function accessToken(client: TailscaleClient, fetchFn: Fetch): Promise<string> {
  const body = await post(
    fetchFn,
    `${API}/oauth/token`,
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client.id, client_secret: client.secret }).toString(),
    },
    'the OAuth client',
  );
  if (typeof body.access_token !== 'string' || body.access_token === '') throw new TailscaleError('Tailscale answered the OAuth client without a token.');
  return body.access_token;
}

export async function mintAuthKey(client: TailscaleClient, node: string, fetchFn: Fetch = fetch): Promise<string> {
  const token = await accessToken(client, fetchFn);
  const body = await post(
    fetchFn,
    `${API}/tailnet/-/keys`,
    {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [BOX_TAG] } } },
        expirySeconds: KEY_TTL_SECONDS,
        description: `metro launch ${node}`.slice(0, 50),
      }),
    },
    `an auth key for ${BOX_TAG}`,
  );
  if (typeof body.key !== 'string' || !AUTH_KEY_RE.test(body.key)) throw new TailscaleError('Tailscale answered without an auth key.');
  return body.key;
}
