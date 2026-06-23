import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeAccountStore, csv, genIds } from '@metro-labs/metro/stations/account-store';

const ACCOUNTS_FILE =
  process.env.TELEGRAM_ACCOUNTS_FILE ??
  join(homedir(), '.metro', 'telegram-accounts.json');

export interface AccountConfig {
  id: string;
  token: string;
  owner?: string;
}

export const legacy = {
  defaultLines: process.env.TELEGRAM_LEGACY_DEFAULT_LINES === '1',
};

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
  fallback(die) {
    const tokens = csv(process.env.TELEGRAM_BOT_TOKENS);
    if (!tokens.length)
      return die(`no ${ACCOUNTS_FILE} and TELEGRAM_BOT_TOKENS unset`);
    const ids = genIds('t', tokens.length);
    return tokens.map((token, i) => ({ id: ids[i], token }));
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
  let id = args.account;
  if (!id && args.line) {
    try {
      id = targetOf(args.line).accountId;
    } catch {
    }
  }
  id ??= accounts.size === 1 ? [...accounts.keys()][0] : 'default';
  if (!accounts.has(id))
    throw new Error(
      `unknown account '${id}' (have: ${[...accounts.keys()].join(', ')})`,
    );
  return id;
}

export function lineOf(
  accountId: string,
  chatId: number | string,
  topicId?: number,
): string {
  const tail = topicId !== undefined ? `${chatId}/${topicId}` : `${chatId}`;
  if (accountId === 'default' && legacy.defaultLines)
    return `metro://telegram/${tail}`;
  return `metro://telegram/${accountId}/${tail}`;
}

export function targetOf(
  line: string,
  accountOverride?: string,
): { accountId: string; chatId: number; topicId?: number } {
  const mNew = /^metro:\/\/telegram\/([^/]+)\/(-?\d+)(?:\/(\d+))?$/.exec(line);
  if (mNew && !/^-?\d+$/.test(mNew[1])) {
    return {
      accountId: accountOverride ?? mNew[1],
      chatId: Number(mNew[2]),
      topicId: mNew[3] ? Number(mNew[3]) : undefined,
    };
  }
  const mLegacy = /^metro:\/\/telegram\/(-?\d+)(?:\/(\d+))?$/.exec(line);
  if (mLegacy) {
    return {
      accountId: accountOverride ?? 'default',
      chatId: Number(mLegacy[1]),
      topicId: mLegacy[2] ? Number(mLegacy[2]) : undefined,
    };
  }
  throw new Error(`bad telegram line: ${line}`);
}
