import { Client } from 'discord.js';
import {
  makeAccountStore,
  resolveAccountId,
} from '@metro-labs/core/stations/account-store';
import { Line } from '@metro-labs/core/lines';
import { emit } from '@metro-labs/core/stations/station-runtime';
import { API } from './api-base.js';

export interface AccountConfig {
  id: string;
  token: string;
}

export const { loadAccounts } = makeAccountStore<AccountConfig>({
  prefix: 'discord-bot',
  validate(raw, die) {
    for (const a of raw)
      if (!a.token || typeof a.token !== 'string')
        die(`account '${a.id}' missing token`);
  },
});

export interface Account {
  cfg: AccountConfig;
  client: Client;
}
export const accounts = new Map<string, Account>();

function restBody(
  body: unknown,
  isForm: boolean,
): RequestInit['body'] | undefined {
  if (body === undefined) return undefined;
  return isForm ? (body as RequestInit['body']) : JSON.stringify(body);
}

async function restResult<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('application/json')) return res.json() as Promise<T>;
  return res.arrayBuffer().then((b) => Buffer.from(b) as unknown as T);
}

export async function rest<T = unknown>(
  accountId: string,
  method: string,
  path: string,
  body?: unknown,
  isForm = false,
): Promise<T> {
  const acct = accounts.get(accountId);
  if (!acct) throw new Error(`unknown account '${accountId}'`);
  const headers: Record<string, string> = {
    Authorization: `Bot ${acct.cfg.token}`,
    'User-Agent': 'metro-discord-bot-train (https://github.com/bonustrack/stage)',
  };
  if (body !== undefined && !isForm)
    headers['Content-Type'] = 'application/json';
  emit({ op: 'log', text: `discord-bot[${accountId}] api ${method} ${path}` });
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: restBody(body, isForm),
    signal: AbortSignal.timeout(30_000),
  });
  emit({
    op: 'log',
    text: `discord-bot[${accountId}] api ${method} ${path} -> ${res.status}`,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`discord-bot ${method} ${path}: ${res.status} ${text}`);
  }
  return restResult<T>(res);
}

export function lineOf(accountId: string, channelId: string): string {
  return `metro://discord-bot/${accountId}/${channelId}`;
}

export function parseLine(
  line: string,
): { accountId: string; channelId: string } | null {
  const p = Line.parseDiscord(line);
  return p ? { accountId: p.accountId, channelId: p.resource } : null;
}

export function accountFor(args: { account?: string; line?: string }): string {
  return resolveAccountId(accounts, args, (line) => parseLine(line)?.accountId);
}

export function routeOf(
  line: string,
  account?: string,
): { accountId: string; channelId: string } {
  const parsed = parseLine(line);
  if (!parsed) throw new Error(`bad discord-bot line: ${line}`);
  const accountId = account ?? parsed.accountId;
  if (!accounts.has(accountId))
    throw new Error(`unknown account '${accountId}' in line ${line}`);
  return { accountId, channelId: parsed.channelId };
}

export const encodeEmoji = (e: string): string => encodeURIComponent(e);
