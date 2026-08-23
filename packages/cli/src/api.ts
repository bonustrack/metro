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

async function get(path: string): Promise<unknown> {
  const auth = tokenOrThrow();
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

async function post(path: string, body: unknown): Promise<unknown> {
  if (!carriesSecretsSafely(metroUrl()))
    throw new Error(
      `refusing to send your code to ${metroUrl()} in the clear — use https, or a loopback address`,
    );
  let res: Response;
  try {
    res = await fetch(`${metroUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(`could not reach ${metroUrl()}`);
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (res.ok) return parsed;
  const detail = isRecord(parsed) ? parsed.error : undefined;
  throw new Error(
    typeof detail === 'string' ? detail : `metro answered ${String(res.status)}`,
  );
}

export interface Authorized {
  token: string;
  email: string;
  collection: string;
}

export async function claimCode(code: string): Promise<Authorized> {
  const body = await post('/api/cli/claim', { code });
  if (
    !isRecord(body) ||
    typeof body.token !== 'string' ||
    typeof body.email !== 'string' ||
    typeof body.collection !== 'string'
  )
    throw new Error('metro returned an unexpected response');
  return {
    token: body.token,
    email: body.email,
    collection: body.collection,
  };
}

export interface RunClaimed {
  token: string;
  agent: string;
  label: string;
}

export async function claimRuntime(
  code: string,
  label: string,
): Promise<RunClaimed> {
  const body = await post('/api/run/claim', { code, label });
  if (
    !isRecord(body) ||
    typeof body.token !== 'string' ||
    typeof body.agent !== 'string' ||
    typeof body.label !== 'string'
  )
    throw new Error('metro returned an unexpected response');
  return { token: body.token, agent: body.agent, label: body.label };
}

export async function mcpServers(): Promise<string> {
  const body = await get('/api/cli/mcp');
  if (!isRecord(body) || typeof body.json !== 'string')
    throw new Error('metro returned an unexpected response');
  return body.json;
}

export async function whoisAuthorized(): Promise<{
  email: string;
  collection: string;
}> {
  const body = await get('/api/cli/session');
  if (
    !isRecord(body) ||
    typeof body.email !== 'string' ||
    typeof body.collection !== 'string'
  )
    throw new Error('metro returned an unexpected response');
  return { email: body.email, collection: body.collection };
}
