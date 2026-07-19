import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  makeAccountStore,
  resolveAccountId,
  type Die,
} from '@metro-labs/mcp/stations/account-store';
import type { UserAccount } from './types.js';

const ACCOUNTS_FILE =
  process.env.TELEGRAM_USER_ACCOUNTS_FILE ??
  join(homedir(), '.metro', 'telegram-user-accounts.json');

const isSignedInt = (s: string): boolean => /^-?\d+$/.test(s);
const isTopic = (s: string): boolean => /^\d+$/.test(s);

function validateAccount(a: UserAccount, seen: Set<string>, die: Die): void {
  if (!a.id) die('account missing id');
  if (!a.session || typeof a.session !== 'string')
    die(`account '${a.id}' missing session`);
  if (!Number.isInteger(a.apiId) || (a.apiId ?? 0) <= 0)
    die(`account '${a.id}' missing apiId`);
  if (!a.apiHash || typeof a.apiHash !== 'string')
    die(`account '${a.id}' missing apiHash`);
  if (seen.has(a.id)) die(`duplicate account id '${a.id}'`);
  seen.add(a.id);
}

export const { loadAccounts } = makeAccountStore<UserAccount>({
  prefix: 'telegram-user',
  file: ACCOUNTS_FILE,
  allowlistEnv: ['TELEGRAM_USER_ONLY_ACCOUNTS', 'TELEGRAM_USER_ACCOUNTS'],
  validate(raw, die) {
    const seen = new Set<string>();
    for (const a of raw) validateAccount(a, seen, die);
  },
});

export const accounts = new Map<string, UserAccount>();

export function accountFor(args: { account?: string; line?: string }): string {
  return resolveAccountId(accounts, args, (line) => targetOf(line)?.accountId);
}

export function lineOf(
  accountId: string,
  chatId: number | string,
  topicId?: number,
): string {
  const tail = topicId !== undefined ? `${chatId}/${topicId}` : `${chatId}`;
  return `metro://telegram-user/${accountId}/${tail}`;
}

interface Target {
  accountId: string;
  chatId: number;
  topicId?: number;
}

function splitScoped(path: string[]): { accountId: string; rest: string[] } {
  const first = path[0];
  if (path.length >= 2 && first !== undefined && !isSignedInt(first))
    return { accountId: first, rest: path.slice(1) };
  return { accountId: 'default', rest: path };
}

export function targetOf(line: string): Target | undefined {
  const prefix = 'metro://telegram-user/';
  if (!line.startsWith(prefix)) return undefined;
  const path = line.slice(prefix.length).split('/').filter(Boolean);
  const { accountId, rest } = splitScoped(path);
  const [chatId, topicId] = rest;
  if (rest.length < 1 || rest.length > 2 || chatId === undefined) return undefined;
  if (!isSignedInt(chatId)) return undefined;
  if (topicId !== undefined && !isTopic(topicId)) return undefined;
  return {
    accountId,
    chatId: Number(chatId),
    ...(topicId !== undefined ? { topicId: Number(topicId) } : {}),
  };
}
