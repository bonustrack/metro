import {
  makeAccountStore,
  resolveAccountId,
  type Die,
} from '@metro-labs/core/stations/account-store';
import type { UserAccount } from './types.js';

const isSignedInt = (s: string): boolean => /^-?\d+$/.test(s);
const isTopic = (s: string): boolean => /^\d+$/.test(s);

function validateAccount(a: UserAccount, die: Die): void {
  if (!a.session || typeof a.session !== 'string')
    die(`account '${a.id}' missing session`);
  if (!Number.isInteger(a.apiId) || (a.apiId ?? 0) <= 0)
    die(`account '${a.id}' missing apiId`);
  if (!a.apiHash || typeof a.apiHash !== 'string')
    die(`account '${a.id}' missing apiHash`);
}

export const { loadAccounts } = makeAccountStore<UserAccount>({
  prefix: 'telegram',
  validate(raw, die) {
    for (const a of raw) validateAccount(a, die);
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
  return `metro://telegram/${accountId}/${tail}`;
}

interface Target {
  accountId: string;
  chatId: number;
  topicId?: number;
}

export function targetOf(line: string): Target | undefined {
  const prefix = 'metro://telegram/';
  if (!line.startsWith(prefix)) return undefined;
  const path = line.slice(prefix.length).split('/').filter(Boolean);
  const [accountId, ...rest] = path;
  const [chatId, topicId] = rest;
  if (accountId === undefined || chatId === undefined || rest.length > 2) return undefined;
  if (!isSignedInt(chatId)) return undefined;
  if (topicId !== undefined && !isTopic(topicId)) return undefined;
  return {
    accountId,
    chatId: Number(chatId),
    ...(topicId !== undefined ? { topicId: Number(topicId) } : {}),
  };
}
