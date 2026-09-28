import { refusalOf, type MailService } from '@metro-labs/core/stations/mail';
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

const OUTLOOK: MailService = { station: 'outlook', company: 'Microsoft', product: 'Outlook', api: 'Microsoft Graph', apiCode: 'graph_error' };

async function refusal(res: Response): Promise<Error> {
  const detail = await graphMessage(res);
  return res.status === 410 ? new GraphGone(detail) : refusalOf(OUTLOOK, res.status, detail);
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
