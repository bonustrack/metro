import { TrainError } from '@metro-labs/core/train-error';
import type { Account } from './accounts.js';
import { graphBase } from './config.js';

type Json = Record<string, unknown>;

const urlOf = (path: string): string => (/^https?:\/\//.test(path) ? path : `${graphBase()}${path}`);

async function graphMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: unknown; message?: unknown } };
  const message = typeof body.error?.message === 'string' ? body.error.message : '';
  const code = typeof body.error?.code === 'string' ? body.error.code : '';
  return [code, message].filter((s) => s !== '').join(': ') || `HTTP ${String(res.status)}`;
}

export class GraphGone extends Error {}

async function refusal(res: Response): Promise<Error> {
  const detail = await graphMessage(res);
  const status = res.status;
  if (status === 410) return new GraphGone(detail);
  if (status === 401) return new TrainError('outlook_signed_out', `Microsoft refused this mailbox's sign-in (${detail}); connect Outlook again from the page`, { retryable: false });
  if (status === 403) return new TrainError('outlook_forbidden', `Microsoft does not let Metro do that on this mailbox (${detail})`, { retryable: false });
  if (status === 404) return new TrainError('outlook_not_found', `Outlook has no such message or conversation (${detail})`, { retryable: false });
  if (status === 413) return new TrainError('outlook_too_large', `Outlook refused the size of that request (${detail})`, { retryable: false });
  if (status === 429) return new TrainError('outlook_throttled', `Microsoft asked Metro to slow down (${detail}); try again in a minute`, { retryable: true });
  return new TrainError('outlook_graph_error', `Microsoft Graph answered ${String(status)} (${detail})`, { retryable: status >= 500 });
}

async function send(acct: Account, path: string, init: RequestInit, force: boolean): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${await acct.token(force)}`);
  headers.set('accept', 'application/json');
  return acct.fetch(urlOf(path), { ...init, headers });
}

export async function graph(acct: Account, path: string, init: RequestInit = {}): Promise<Response> {
  let res = await send(acct, path, init, false);
  if (res.status === 401) res = await send(acct, path, init, true);
  if (!res.ok) throw await refusal(res);
  return res;
}

export async function graphJson<T = Json>(acct: Account, path: string, init: RequestInit = {}): Promise<T> {
  const res = await graph(acct, path, init);
  return (await res.json()) as T;
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const odataQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export const queryOf = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

export const messagePath = (messageId: string): string => `/me/messages/${encodeURIComponent(messageId)}`;
