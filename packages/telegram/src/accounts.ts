import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  makeAccountStore,
  resolveAccountId,
} from '@metro-labs/mcp/stations/account-store';
import { Line } from '@metro-labs/mcp/lines';

const ACCOUNTS_FILE =
  process.env.TELEGRAM_ACCOUNTS_FILE ??
  join(homedir(), '.metro', 'telegram-accounts.json');

export interface AccountConfig {
  id: string;
  token: string;
  owner?: string;
}

export const { loadAccounts } = makeAccountStore<AccountConfig>({
  prefix: 'telegram',
  file: ACCOUNTS_FILE,
  allowlistEnv: ['TELEGRAM_ONLY_ACCOUNTS', 'TELEGRAM_ACCOUNTS'],
  validate(raw, die) {
    const seenId = new Set<string>();
    const seenTok = new Set<string>();
    for (const a of raw) {
      if (!a.id) die('account missing id');
      if (!a.token || typeof a.token !== 'string')
        die(`account '${a.id}' missing token`);
      if (seenId.has(a.id)) die(`duplicate account id '${a.id}'`);
      if (seenTok.has(a.token))
        die(
          `account '${a.id}' reuses a token used by another account (409 on getUpdates)`,
        );
      seenId.add(a.id);
      seenTok.add(a.token);
    }
  },
});

export interface Account {
  cfg: AccountConfig;
  api: string;
  fileApi: string;
  offset: number;
}
export const accounts = new Map<string, Account>();

export async function tg<T>(
  accountId: string,
  method: string,
  body: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const acct = accounts.get(accountId);
  if (!acct) throw new Error(`unknown account '${accountId}'`);
  const res = await fetch(`${acct.api}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: T;
  };
  if (!json.ok)
    throw new Error(`telegram ${method}: ${json.description ?? 'unknown'}`);
  return json.result as T;
}

export async function tgForm<T>(
  accountId: string,
  method: string,
  form: FormData,
  timeoutMs = 60_000,
): Promise<T> {
  const acct = accounts.get(accountId);
  if (!acct) throw new Error(`unknown account '${accountId}'`);
  const res = await fetch(`${acct.api}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: T;
  };
  if (!json.ok)
    throw new Error(`telegram ${method}: ${json.description ?? 'unknown'}`);
  return json.result as T;
}

export function accountFor(args: { account?: string; line?: string }): string {
  return resolveAccountId(
    accounts,
    args,
    (line) => Line.parseTelegram(line)?.accountId,
  );
}

export function lineOf(
  accountId: string,
  chatId: number | string,
  topicId?: number,
): string {
  const tail = topicId !== undefined ? `${chatId}/${topicId}` : `${chatId}`;
  return `metro://telegram/${accountId}/${tail}`;
}

export function targetOf(
  line: string,
  accountOverride?: string,
): { accountId: string; chatId: number; topicId?: number } {
  const parsed = Line.parseTelegram(line);
  if (!parsed) throw new Error(`bad telegram line: ${line}`);
  return { ...parsed, accountId: accountOverride ?? parsed.accountId };
}
