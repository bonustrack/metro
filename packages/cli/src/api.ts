import { metroUrl, readToken } from './store.js';

export class NotSignedIn extends Error {}

const TIMEOUT_MS = 20_000;

function tokenOrThrow(): string {
  const token = readToken();
  if (token === null)
    throw new NotSignedIn('not signed in — run `metro login` first');
  return token;
}

async function get(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${metroUrl()}${path}`, {
      headers: { authorization: `Bearer ${tokenOrThrow()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof NotSignedIn) throw err;
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

export async function sessionEmail(): Promise<string> {
  const body = await get('/api/session');
  if (!isRecord(body) || typeof body.email !== 'string')
    throw new Error('metro returned an unexpected response');
  return body.email;
}
