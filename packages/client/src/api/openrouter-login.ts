import { activeAccount } from '../auth/account.js';
import { daemonBase } from '../auth/daemon.js';
import { isRecord } from '../read.js';
import { call } from './client.js';

export const OPENROUTER_LOGIN_SINCE = '0.1.0-beta.261';
const PATH = '/api/model/openrouter/login';
const unexpected = (): Error => new Error('Metro returned an unexpected OpenRouter sign-in response.');

export interface OpenRouterLogin {
  id: string;
  url: string;
  expiresAt: number;
  base: string;
  organization: string;
  user: string;
}

export type OpenRouterStatus = { status: 'pending' } | { status: 'done'; connection: string } | { status: 'failed'; error: string };

function checkAccount(login: Pick<OpenRouterLogin, 'organization' | 'user'>): void {
  const account = activeAccount();
  if (account?.organization !== login.organization || account.user.id !== login.user)
    throw new Error('The Metro account changed. Start the sign-in again.');
}

function checkBox(login: OpenRouterLogin): void {
  checkAccount(login);
  if (daemonBase() !== login.base) throw new Error('The selected box changed. Return to the original box to check this sign-in.');
}

function authorizationUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== 'https://openrouter.ai' || url.pathname !== '/auth' || url.username !== '' || url.password !== '') throw unexpected();
  return value;
}

function parseStarted(body: unknown): Pick<OpenRouterLogin, 'id' | 'url' | 'expiresAt'> {
  if (!isRecord(body) || typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.id) || typeof body.url !== 'string' || typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt)) throw unexpected();
  return { id: body.id, url: authorizationUrl(body.url), expiresAt: body.expiresAt };
}

export async function beginOpenRouterLogin(connection = ''): Promise<OpenRouterLogin> {
  const account = activeAccount();
  if (account?.organization === null || account?.organization === undefined) throw new Error('Sign in to Metro first.');
  const origin = { base: daemonBase(), organization: account.organization, user: account.user.id };
  const query = connection === '' ? '' : `?connection=${encodeURIComponent(connection)}`;
  const body = await call({ method: 'POST', base: origin.base, path: `${PATH}${query}`, checkAccount: () => { checkAccount(origin); } });
  const login = { ...origin, ...parseStarted(body) };
  checkBox(login);
  return login;
}

function statusOf(body: unknown): OpenRouterStatus {
  if (!isRecord(body)) throw unexpected();
  if (body.status === 'pending') return { status: 'pending' };
  if (body.status === 'done' && typeof body.connection === 'string') return { status: 'done', connection: body.connection };
  if (body.status === 'failed' && typeof body.error === 'string') return { status: 'failed', error: body.error };
  throw unexpected();
}

export async function pollOpenRouterLogin(login: OpenRouterLogin): Promise<OpenRouterStatus> {
  checkBox(login);
  const body = await call({ method: 'GET', base: login.base, path: `${PATH}/${encodeURIComponent(login.id)}`, checkAccount: () => { checkBox(login); } });
  checkBox(login);
  return statusOf(body);
}

export async function cancelOpenRouterLogin(login: OpenRouterLogin): Promise<OpenRouterStatus> {
  checkAccount(login);
  const body = await call({ method: 'DELETE', base: login.base, path: `${PATH}/${encodeURIComponent(login.id)}`, checkAccount: () => { checkAccount(login); } });
  checkAccount(login);
  return statusOf(body);
}
