import { refusalOf, type MailService } from '@metro-labs/core/stations/mail';
import type { Account } from './accounts.js';
import { googleMessage } from './auth.js';
import { apiBase } from './config.js';

const GMAIL: MailService = { station: 'gmail', company: 'Google', product: 'Gmail', api: 'The Gmail API', apiCode: 'api_error' };

export const USER = '/gmail/v1/users/me';

export class HistoryGone extends Error {}

async function call(acct: Account, path: string, init: RequestInit, force: boolean): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${await acct.token(force)}`);
  headers.set('accept', 'application/json');
  return acct.fetch(`${apiBase()}${path}`, { ...init, headers });
}

export async function gmail(acct: Account, path: string, init: RequestInit = {}): Promise<Response> {
  let res = await call(acct, path, init, false);
  if (res.status === 401) res = await call(acct, path, init, true);
  if (res.ok) return res;
  const detail = await googleMessage(res);
  acct.check();
  throw res.status === 404 && path.startsWith(`${USER}/history`) ? new HistoryGone(detail) : refusalOf(GMAIL, res.status, detail);
}

export async function gmailJson<T>(acct: Account, path: string, init: RequestInit = {}): Promise<T> {
  const body = (await (await gmail(acct, path, init)).json()) as T;
  acct.check();
  return body;
}

export const queryOf = (params: [string, string][]): string => new URLSearchParams(params).toString();
