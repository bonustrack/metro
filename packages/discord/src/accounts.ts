import { Client } from 'discord.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  makeAccountStore,
  csv,
  genIds,
  resolveAccountId,
} from '@metro-labs/mcp/stations/account-store';
import { Line } from '@metro-labs/mcp/lines';

export const API = 'https://discord.com/api/v10';

const ACCOUNTS_FILE =
  process.env.DISCORD_ACCOUNTS_FILE ??
  join(homedir(), '.metro', 'discord-accounts.json');

export interface AccountConfig {
  id: string;
  token: string;
  owner?: string;
}

export const legacy = {
  defaultLines: process.env.DISCORD_LEGACY_DEFAULT_LINES === '1',
};

export const { loadAccounts } = makeAccountStore<AccountConfig>({
  prefix: 'discord',
  file: ACCOUNTS_FILE,
  allowlistEnv: ['DISCORD_ONLY_ACCOUNTS', 'DISCORD_ACCOUNTS'],
  validate(raw, die) {
    const seen = new Set<string>();
    for (const a of raw) {
      if (!a.id) die('account missing id');
      if (!a.token || typeof a.token !== 'string')
        die(`account '${a.id}' missing token`);
      if (seen.has(a.id)) die(`duplicate account id '${a.id}'`);
      seen.add(a.id);
    }
  },
  fallback(die) {
    const tokens = csv(process.env.DISCORD_BOT_TOKENS);
    if (!tokens.length)
      return die(`no ${ACCOUNTS_FILE} and DISCORD_BOT_TOKENS unset`);
    const ids = genIds('d', tokens.length);
    return tokens.map((token, i) => ({ id: ids[i], token }));
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
    'User-Agent': 'metro-discord-train (https://github.com/bonustrack/stage)',
  };
  if (body !== undefined && !isForm)
    headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: restBody(body, isForm),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`discord ${method} ${path}: ${res.status} ${text}`);
  }
  return restResult<T>(res);
}

export function lineOf(accountId: string, channelId: string): string {
  if (accountId === 'default' && legacy.defaultLines)
    return `metro://discord/${channelId}`;
  return `metro://discord/${accountId}/${channelId}`;
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
  if (!parsed) throw new Error(`bad discord line: ${line}`);
  const accountId = account ?? parsed.accountId;
  if (!accounts.has(accountId))
    throw new Error(`unknown account '${accountId}' in line ${line}`);
  return { accountId, channelId: parsed.channelId };
}

export const encodeEmoji = (e: string): string => encodeURIComponent(e);
