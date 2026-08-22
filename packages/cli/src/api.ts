import { metroUrl, readToken } from './store.js';

export class NotSignedIn extends Error {}

const TIMEOUT_MS = 20_000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function carriesSecretsSafely(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

function tokenOrThrow(): string {
  if (!carriesSecretsSafely(metroUrl()))
    throw new Error(
      `refusing to send your session to ${metroUrl()} in the clear — use https, or a loopback address`,
    );
  const token = readToken();
  if (token === null)
    throw new NotSignedIn('not signed in — run `metro login` first');
  return token;
}

async function get(path: string, presented?: string): Promise<unknown> {
  const auth = presented ?? tokenOrThrow();
  let res: Response;
  try {
    res = await fetch(`${metroUrl()}${path}`, {
      headers: { authorization: `Bearer ${auth}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(`could not reach ${metroUrl()}`);
  }
  if (res.status === 401)
    throw new NotSignedIn('that sign-in has expired — run `metro login` again');
  if (!res.ok) throw new Error(`metro answered ${String(res.status)}`);
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function mcpServers(): Promise<string> {
  const body = await get('/api/connectors');
  if (!isRecord(body) || typeof body.json !== 'string')
    throw new Error('metro returned an unexpected response');
  return body.json;
}

export async function sessionEmail(presented?: string): Promise<string> {
  const body = await get('/api/session', presented);
  if (!isRecord(body) || typeof body.email !== 'string')
    throw new Error('metro returned an unexpected response');
  return body.email;
}
